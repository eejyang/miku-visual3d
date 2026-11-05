import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { ViewerSession, type Source } from "../src/backend/session";
import { RemoteVolume } from "../src/backend/nifti";
import type { HostMessage } from "../src/protocol";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function image(
  name: string,
  frames = 1,
  offset = 0,
  dimension = 16,
  configure?: (bytes: Buffer) => void,
): Promise<Source> {
  const dir = await mkdtemp(join(tmpdir(), "miku-visual-session-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const count = dimension ** 3 * frames,
    bytes = Buffer.alloc(352 + count * 2);
  bytes.writeInt32LE(348, 0);
  bytes.set([110, 43, 49, 0], 344);
  bytes.writeInt16LE(4, 40);
  for (let i = 0; i < 3; i++) {
    bytes.writeInt16LE(dimension, 42 + i * 2);
    bytes.writeFloatLE(1, 80 + i * 4);
  }
  bytes.writeInt16LE(frames, 48);
  bytes.writeInt16LE(4, 70);
  bytes.writeInt16LE(16, 72);
  bytes.writeFloatLE(352, 108);
  for (let i = 0; i < count; i++) bytes.writeInt16LE(i + offset, 352 + i * 2);
  configure?.(bytes);
  const path = join(dir, name);
  await writeFile(path, gzipSync(bytes));
  return { path, name };
}

async function viewer(source: Source) {
  const messages: HostMessage[] = [];
  const pickOverlay = vi.fn<() => Promise<Source | undefined>>();
  const session = new ViewerSession(source, {
    post: (m) => messages.push(m),
    log() {},
    pickOverlay,
  });
  cleanups.push(() => session.dispose());
  await session.receive({ type: "ready" });
  const slices = () => messages.filter((m) => m.type === "slice");
  return { session, messages, slices, pickOverlay };
}

it("coalesces navigation per plane and sends only the latest requested slice", async () => {
  const { session, messages, slices } = await viewer(
    await image("base.nii.gz"),
  );
  for (let id = 1; id <= 120; id++) {
    await session.receive({
      type: "slice",
      request: { id, axis: id % 3, index: id % 16, frame: 0 },
    });
  }
  await vi.waitFor(() => expect(slices()).toHaveLength(3));
  expect(
    slices()
      .map((m) => m.request.id)
      .sort((a, b) => a - b),
  ).toEqual([118, 119, 120]);
  expect(messages.filter((m) => m.type === "error")).toEqual([]);
  for (const message of slices()) {
    expect(Buffer.from(message.base.pixels, "base64").length).toBe(16 * 16 * 4);
    expect(message).not.toHaveProperty("path");
  }
});

it("inherits base geometry and keeps the current overlay if replacement dimensions differ", async () => {
  const { session, messages, slices, pickOverlay } = await viewer(
    await image("base.nii.gz", 2),
  );
  pickOverlay.mockResolvedValueOnce(
    await image("overlay.nii.gz", 1, 100, 16, (bytes) => {
      bytes.writeFloatLE(Number.NaN, 80);
      bytes.writeInt16LE(1, 254);
      bytes.fill(0, 280, 328);
      bytes.writeUInt8(2, 123);
    }),
  );
  await session.receive({ type: "overlay" });
  const baseInfo = messages.find((m) => m.type === "volume")!;
  const overlayInfo = messages.find((m) => m.type === "overlay")!;
  expect(overlayInfo.volume).toEqual({
    ...baseInfo.volume,
    name: "overlay.nii.gz",
    frames: 1,
  });
  await session.receive({
    type: "slice",
    request: { id: 1, axis: 2, index: 0, frame: 1 },
  });
  await vi.waitFor(() => expect(slices()).toHaveLength(1));
  expect(Buffer.from(slices()[0].base.pixels, "base64").readFloatLE(0)).toBe(
    4096,
  );
  expect(
    Buffer.from(slices()[0].overlay!.pixels, "base64").readFloatLE(0),
  ).toBe(100);

  pickOverlay.mockResolvedValueOnce(await image("wrong-grid.nii.gz", 1, 0, 8));
  await session.receive({ type: "overlay" });
  expect(messages.at(-1)).toMatchObject({
    type: "error",
    message: expect.stringContaining("尺寸不匹配"),
  });
  await session.receive({
    type: "slice",
    request: { id: 2, axis: 2, index: 0, frame: 1 },
  });
  await vi.waitFor(() => expect(slices()).toHaveLength(2));
  expect(
    Buffer.from(slices()[1].overlay!.pixels, "base64").readFloatLE(0),
  ).toBe(100);

  await session.receive({ type: "removeOverlay" });
  await session.receive({
    type: "slice",
    request: { id: 3, axis: 2, index: 0, frame: 1 },
  });
  await vi.waitFor(() => expect(slices()).toHaveLength(3));
  expect(slices()[2].overlay).toBeUndefined();
});

it("reports a failed slice with its request id and accepts the next request", async () => {
  const { session, messages, slices } = await viewer(
    await image("base.nii.gz"),
  );
  await session.receive({
    type: "slice",
    request: { id: 1, axis: 2, index: 999, frame: 0 },
  });
  await vi.waitFor(() =>
    expect(messages.at(-1)).toMatchObject({ type: "error", id: 1 }),
  );
  await session.receive({
    type: "slice",
    request: { id: 2, axis: 2, index: 0, frame: 0 },
  });
  await vi.waitFor(() => expect(slices()).toHaveLength(1));
  expect(slices()[0].request.id).toBe(2);
  await session.dispose();
  const count = messages.length;
  await session.receive({ type: "ready" });
  expect(messages).toHaveLength(count);
});

it("retains multiple sources while selecting the requested source for 2D pixels", async () => {
  const { session, messages, slices } = await viewer(
    await image("base.nii.gz", 2),
  );
  await session.addOverlay([
    await image("GT.nii.gz", 1, 100),
    await image("Prediction.nii.gz", 1, 200),
  ]);
  expect(messages.at(-1)).toMatchObject({
    type: "overlay",
    activeId: "mask-2",
    layers: [{ id: "mask-1" }, { id: "mask-2" }],
  });
  await session.receive({
    type: "slice",
    request: { id: 1, axis: 2, index: 0, frame: 1 },
  });
  await vi.waitFor(() => expect(slices()).toHaveLength(1));
  expect(
    Buffer.from(slices()[0].overlay!.pixels, "base64").readFloatLE(0),
  ).toBe(200);
  await session.receive({ type: "selectOverlay", layerId: "mask-1" });
  await session.receive({
    type: "slice",
    request: { id: 2, axis: 2, index: 0, frame: 1 },
  });
  await vi.waitFor(() => expect(slices()).toHaveLength(2));
  expect(
    Buffer.from(slices()[1].overlay!.pixels, "base64").readFloatLE(0),
  ).toBe(100);
  await session.receive({ type: "removeOverlay", layerId: "mask-2" });
  expect(messages.at(-1)).toMatchObject({
    type: "overlay",
    activeId: "mask-1",
    layers: [{ id: "mask-1" }],
  });
});

it("automatically registers a low-cardinality source mask without a separate command", async () => {
  const { session, messages, slices } = await viewer(
    await image("arbitrary-name.nii.gz", 1, 0, 16, (bytes) =>
      bytes.fill(0, 352),
    ),
  );
  expect(session.diagnostics.sourceKind).toBe("mask");
  expect(messages.at(-1)).toMatchObject({
    type: "overlay",
    layers: [{ id: "mask-1" }],
  });
  await session.receive({
    type: "slice",
    request: { id: 1, axis: 2, index: 0, frame: 0 },
  });
  await vi.waitFor(() => expect(slices()).toHaveLength(1));
  expect(slices()[0].overlay).toBeDefined();
});

it("does not publish an image mode while a slow mask classification is still pending", async () => {
  const source = await image("slow-mask.nii.gz", 1, 0, 16, (bytes) =>
    bytes.fill(0, 352),
  );
  const original = RemoteVolume.prototype.classifySource;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const classify = vi
    .spyOn(RemoteVolume.prototype, "classifySource")
    .mockImplementationOnce(async function (signal) {
      await gate;
      return original.call(this, signal);
    });
  const messages: HostMessage[] = [];
  const session = new ViewerSession(source, {
    post: (m) => messages.push(m),
    log() {},
    pickOverlay: async () => undefined,
  });
  cleanups.push(() => session.dispose());
  const starting = session.receive({ type: "ready" });
  await vi.waitFor(() => expect(classify).toHaveBeenCalledOnce());
  try {
    await session.receive({ type: "ready" });
    expect(messages.filter((m) => m.type === "volume")).toEqual([]);
  } finally {
    release();
  }
  await starting;
  expect(messages.filter((m) => m.type === "volume")).toMatchObject([
    { sourceKind: "mask" },
  ]);
});
