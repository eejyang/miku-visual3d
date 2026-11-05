import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { build } from "esbuild";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { ViewerSession } from "../src/backend/session";
import type { HostMessage } from "../src/protocol";

let scratch: string, worker: string;
const sessions: ViewerSession[] = [];
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "miku-surface-test-"));
  worker = join(scratch, "surface-worker.cjs");
  await build({
    entryPoints: [resolve("src/backend/surface-worker.ts")],
    outfile: worker,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node18",
  });
});
afterAll(async () => {
  await Promise.all(sessions.map((session) => session.dispose()));
  await rm(scratch, { recursive: true, force: true });
});
async function image(
  name: string,
  frames: number,
  value: (i: number) => number,
) {
  const bytes = Buffer.alloc(352 + 8 ** 3 * frames * 2);
  bytes.writeInt32LE(348, 0);
  bytes.set([110, 43, 49, 0], 344);
  bytes.writeInt16LE(4, 40);
  for (let i = 0; i < 3; i++) {
    bytes.writeInt16LE(8, 42 + i * 2);
    bytes.writeFloatLE(1, 80 + i * 4);
  }
  bytes.writeInt16LE(frames, 48);
  bytes.writeInt16LE(4, 70);
  bytes.writeInt16LE(16, 72);
  bytes.writeFloatLE(352, 108);
  for (let i = 0; i < 8 ** 3 * frames; i++)
    bytes.writeInt16LE(value(i), 352 + i * 2);
  const path = join(scratch, name);
  await writeFile(path, gzipSync(bytes));
  return { path, name };
}
async function viewer(maskFrames: number) {
  const base = await image(`base-${sessions.length}.nii.gz`, 2, (i) => i);
  const mask = await image(`mask-${sessions.length}.nii.gz`, maskFrames, (i) =>
    i < 512 ? 1 : 2,
  );
  const messages: HostMessage[] = [];
  const session = new ViewerSession(
    base,
    { post: (m) => messages.push(m), log() {}, pickOverlay: async () => mask },
    worker,
  );
  sessions.push(session);
  await session.receive({ type: "ready" });
  await session.receive({ type: "overlay" });
  return { session, messages };
}
const ready = (messages: HostMessage[]) =>
  messages.filter((m) => m.type === "surface" && m.surface.state === "ready");
it("extracts multi-frame masks in a real host worker and transmits only meshes", async () => {
  const { session, messages } = await viewer(2);
  await session.receive({ type: "surface", frame: 0 });
  await vi.waitFor(() => expect(ready(messages)).toHaveLength(1));
  const first = ready(messages)[0];
  expect(first).toMatchObject({
    surface: { state: "ready", frame: 0, meshes: [{ label: 1 }] },
  });
  expect(JSON.stringify(first)).not.toContain("pixels");
  expect(JSON.stringify(first)).not.toContain(scratch);
  await session.receive({ type: "surface", frame: 1 });
  await vi.waitFor(() => expect(ready(messages)).toHaveLength(2));
  expect(ready(messages)[1]).toMatchObject({
    surface: { state: "ready", frame: 1, meshes: [{ label: 2 }] },
  });
  await session.receive({ type: "surface", frame: 0 });
  await session.receive({ type: "removeOverlay" });
  const before = ready(messages).length;
  await session.dispose();
  expect(ready(messages)).toHaveLength(before);
  expect(messages.at(-1)).toMatchObject({
    type: "overlay",
    layers: [],
    volume: null,
  });
});
it("reuses a static mask across frames, supports rebuilding, and shuts down pending workers", async () => {
  const { session, messages } = await viewer(1);
  await session.receive({ type: "surface", frame: 0 });
  await vi.waitFor(() => expect(ready(messages)).toHaveLength(1));
  const before = messages.length;
  await session.receive({ type: "surface", frame: 1 });
  expect(messages.length).toBe(before);
  await session.receive({ type: "surface", frame: 1, force: true });
  await vi.waitFor(() => expect(ready(messages)).toHaveLength(2));
  await session.receive({ type: "surface", frame: 0, force: true });
  await session.dispose();
  expect(ready(messages)).toHaveLength(2);
});
it("keeps slices usable after invalid labels", async () => {
  const { session, messages } = await viewer(1);
  await session.addOverlay(await image("not-a-label-mask.nii.gz", 1, (i) => i));
  await session.receive({ type: "surface", frame: 0 });
  await vi.waitFor(() =>
    expect(messages).toContainEqual(
      expect.objectContaining({
        type: "surface",
        surface: {
          state: "error",
          message: expect.stringContaining("128 个标签"),
        },
      }),
    ),
  );
  await session.receive({
    type: "slice",
    request: { id: 1, axis: 2, index: 2, frame: 0 },
  });
  await vi.waitFor(() =>
    expect(messages.some((m) => m.type === "slice")).toBe(true),
  );
  expect(session.diagnostics.errors).toEqual([]);
});

it("keeps GT and prediction with the same label IDs, selects one 2D layer, and removes only the requested source", async () => {
  const { session, messages } = await viewer(1);
  const prediction = await image("prediction.nii.gz", 1, () => 1);
  await session.addOverlay(prediction);
  const layerMessage = messages.filter((m) => m.type === "overlay").at(-1)!;
  expect(layerMessage.layers.map((l) => l.id)).toEqual(["mask-1", "mask-2"]);
  await session.receive({ type: "surface", frame: 0 });
  await vi.waitFor(() => expect(ready(messages)).toHaveLength(2));
  const surfaces = ready(messages);
  expect(surfaces.map((m) => m.layerId)).toEqual(["mask-1", "mask-2"]);
  expect(
    surfaces.every(
      (m) => m.surface.state === "ready" && m.surface.meshes[0].label === 1,
    ),
  ).toBe(true);
  for (const m of surfaces)
    if (m.surface.state === "ready")
      await session.receive({
        type: "surfacePainted",
        layerId: m.layerId,
        revision: m.revision,
        triangles: 10,
        visiblePixels: 20,
      });
  expect(Object.keys(session.diagnostics.surfaces)).toHaveLength(2);
  expect(session.diagnostics.surface?.triangles).toBe(20);
  await session.receive({ type: "selectOverlay", layerId: "mask-1" });
  expect(messages.at(-1)).toMatchObject({
    type: "overlay",
    activeId: "mask-1",
  });
  const before = ready(messages).length;
  await session.receive({ type: "surface", frame: 1 }); // Both masks are static.
  expect(ready(messages).length).toBe(before);
  await session.receive({ type: "removeOverlay", layerId: "mask-2" });
  expect(messages.at(-1)).toMatchObject({
    type: "overlay",
    activeId: "mask-1",
    layers: [{ id: "mask-1" }],
  });
  expect(session.diagnostics.surface?.triangles).toBe(10);
  await session.addOverlay(prediction);
  expect(messages.at(-1)).toMatchObject({
    type: "overlay",
    activeId: "mask-3",
  });
  await session.addOverlay(prediction); // Do not load a duplicate copy of a path.
  expect(messages.at(-1)).toMatchObject({
    type: "overlay",
    layers: [{ id: "mask-1" }, { id: "mask-3" }],
  });
});

it("cancels removed and superseded queued surface requests without erasing other layers", async () => {
  const { session, messages } = await viewer(2);
  await session.addOverlay([
    await image("queue-prediction.nii.gz", 2, (i) => (i < 512 ? 3 : 4)),
    await image("queue-gt.nii.gz", 1, () => 9),
  ]);
  await session.receive({ type: "surface", frame: 0 });
  await session.receive({ type: "surface", frame: 1 });
  await session.receive({ type: "removeOverlay", layerId: "mask-2" });
  await vi.waitFor(() => expect(ready(messages)).toHaveLength(2));
  expect(
    ready(messages)
      .map((m) => m.layerId)
      .sort(),
  ).toEqual(["mask-1", "mask-3"]);
  expect(ready(messages).find((m) => m.layerId === "mask-1")).toMatchObject({
    surface: { frame: 1, meshes: [{ label: 2 }] },
  });
  expect(ready(messages).find((m) => m.layerId === "mask-3")).toMatchObject({
    surface: { frame: 0, meshes: [{ label: 9 }] },
  });
  await session.receive({
    type: "surfacePainted",
    layerId: "mask-2",
    revision: 1,
    triangles: 100,
    visiblePixels: 100,
  });
  await session.receive({
    type: "surfacePainted",
    layerId: "mask-1",
    revision: 1,
    triangles: 100,
    visiblePixels: 100,
  });
  expect(session.diagnostics.surfaces).toEqual({});
  await session.dispose();
});

it("opens a mask without a background image, reuses the source and extracts its surface", async () => {
  const mask = await image("standalone-mask.nii.gz", 2, (i) =>
    i < 512 ? 1 : 2,
  );
  const messages: HostMessage[] = [];
  const session = new ViewerSession(
    mask,
    {
      post: (m) => messages.push(m),
      log() {},
      pickOverlay: async () => undefined,
    },
    worker,
  );
  sessions.push(session);
  await session.receive({ type: "ready" });
  expect(messages.find((m) => m.type === "volume")).toMatchObject({
    sourceKind: "mask",
    volume: { name: mask.name },
  });
  expect(messages.at(-1)).toMatchObject({
    type: "overlay",
    activeId: "mask-1",
    layers: [{ id: "mask-1" }],
  });
  const sourceVolume = [...(session as any).volumes];
  expect(sourceVolume).toHaveLength(1); // No second decompression/file cache for the reference mask.
  await session.receive({ type: "surface", frame: 0 });
  await vi.waitFor(() => expect(ready(messages)).toHaveLength(1));
  expect(ready(messages)[0]).toMatchObject({
    surface: { meshes: [{ label: 1 }] },
  });
  await session.receive({
    type: "slice",
    request: { id: 1, axis: 2, index: 0, frame: 1 },
  });
  await vi.waitFor(() =>
    expect(messages.some((m) => m.type === "slice")).toBe(true),
  );
  const slice = messages.find((m) => m.type === "slice")!;
  expect(Buffer.from(slice.overlay!.pixels, "base64").readFloatLE(0)).toBe(2);
  await session.receive({ type: "removeOverlay" });
  await session.receive({
    type: "slice",
    request: { id: 2, axis: 2, index: 0, frame: 1 },
  });
  await vi.waitFor(() =>
    expect(messages.some((m) => m.type === "slice" && m.request.id === 2)).toBe(
      true,
    ),
  );
  await session.addOverlay(
    await image("standalone-prediction.nii.gz", 1, () => 3),
  );
  await session.receive({ type: "surface", frame: 1 });
  await vi.waitFor(() => expect(ready(messages)).toHaveLength(2));
  expect(ready(messages)[1]).toMatchObject({
    layerId: "mask-2",
    surface: { meshes: [{ label: 3 }] },
  });
});
