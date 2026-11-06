import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gzipSync } from "node:zlib";
import {
  RemoteVolume,
  assertOverlayDimensions,
  parseHeader,
} from "../src/backend/nifti";
import type { SlicePixels, VolumeInfo } from "../src/protocol";

function fixture(v2 = false, le = true) {
  const offset = v2 ? 544 : 352;
  const bytes = Buffer.alloc(offset + 48);
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  v.setInt32(0, v2 ? 540 : 348, le);
  bytes.set(
    v2 ? [110, 43, 50, 0, 13, 10, 26, 10] : [110, 43, 49, 0],
    v2 ? 4 : 344,
  );
  const real = (p: number, n: number) =>
    v2 ? v.setFloat64(p, n, le) : v.setFloat32(p, n, le);
  const dim = (i: number, n: number) =>
    v2
      ? v.setBigInt64(16 + i * 8, BigInt(n), le)
      : v.setInt16(40 + i * 2, n, le);
  dim(0, 4);
  [3, 2, 2, 2].forEach((n, i) => dim(i + 1, n));
  v.setInt16(v2 ? 12 : 70, 4, le);
  v.setInt16(v2 ? 14 : 72, 16, le);
  for (let i = 0; i < 4; i++) {
    real((v2 ? 104 : 76) + i * (v2 ? 8 : 4), i === 3 ? 2 : 1);
  }
  if (v2) {
    v.setBigInt64(168, BigInt(offset), le);
  } else {
    real(108, offset);
  }
  real(v2 ? 176 : 112, 2);
  real(v2 ? 184 : 116, -3);
  for (let i = 0; i < 24; i++) {
    v.setInt16(offset + i * 2, i, le);
  }
  return bytes;
}

const resources: { dispose(): Promise<void> }[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(resources.splice(0).map((v) => v.dispose()));
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
async function volume(bytes: Buffer, gz = false, reference?: VolumeInfo) {
  const dir = await mkdtemp(join(tmpdir(), "niivue-test-"));
  dirs.push(dir);
  const path = join(dir, gz ? "test.nii.gz" : "test.nii");
  await writeFile(path, gz ? gzipSync(bytes) : bytes);
  const result = await RemoteVolume.open(path, "test", undefined, reference);
  resources.push(result);
  return result;
}
function values(plane: SlicePixels | null): number[] {
  expect(plane).not.toBeNull();
  const b = Buffer.from(plane!.pixels, "base64");
  return Array.from({ length: b.length / 4 }, (_, i) => b.readFloatLE(i * 4));
}

describe("remote NIfTI slices", () => {
  it.each([
    [false, true],
    [false, false],
    [true, true],
    [true, false],
  ])(
    "reads NIfTI2=%s littleEndian=%s, applies scaling and frame offsets",
    async (v2, le) => {
      const source = await volume(fixture(v2, le));
      expect(source.info.dimensions).toEqual([3, 2, 2]);
      expect(source.info.frames).toBe(2);
      expect(source.info.spacing).toEqual([1, 1, 2]);
      const slice = await source.slice({ id: 1, axis: 2, index: 1, frame: 1 });
      expect(values(slice)).toEqual(
        [18, 19, 20, 21, 22, 23].map((n) => n * 2 - 3),
      );
      // 24 voxel volume, but only the 6 requested pixels were transmitted.
      expect(Buffer.from(slice!.pixels, "base64").length).toBe(6 * 4);
    },
  );
  it("extracts all three planes in native voxel order", async () => {
    const source = await volume(fixture());
    expect(
      values(await source.slice({ id: 1, axis: 1, index: 1, frame: 0 })),
    ).toEqual([3, 4, 5, 9, 10, 11].map((n) => n * 2 - 3));
    expect(
      values(await source.slice({ id: 2, axis: 0, index: 1, frame: 0 })),
    ).toEqual([1, 4, 7, 10].map((n) => n * 2 - 3));
  });
  it("streams gzip on the host and closes its volume", async () => {
    const source = await volume(fixture(), true);
    expect(
      values(await source.slice({ id: 1, axis: 2, index: 0, frame: 0 })),
    ).toEqual([-3, -1, 1, 3, 5, 7]);
    await source.dispose();
    expect(
      await source.slice({ id: 2, axis: 2, index: 0, frame: 0 }),
    ).toBeNull();
  });
  it("rejects truncated data and unsupported datatypes without sending a file", async () => {
    await expect(volume(fixture().subarray(0, 360))).rejects.toThrow(
      "Truncated",
    );
    const rgb = fixture();
    rgb.writeInt16LE(128, 70);
    expect(() => parseHeader(rgb, "rgb")).toThrow(
      "Unsupported scalar datatype",
    );
  });
  it("checks every slice coordinate and supports cancellation", async () => {
    const source = await volume(fixture());
    await expect(
      source.slice({ id: 1, axis: 2, index: 2, frame: 0 }),
    ).rejects.toThrow("Invalid slice");
    await expect(
      source.slice({ id: 1, axis: 2, index: 0, frame: 2 }),
    ).rejects.toThrow("Invalid slice");
    expect(
      await source.slice({ id: 1, axis: 2, index: 0, frame: 0 }, () => true),
    ).toBeNull();
  });
  it("ignores intercept when slope is zero and handles sform/qform geometry", () => {
    const bytes = fixture();
    bytes.writeFloatLE(0, 112);
    let header = parseHeader(bytes, "test");
    expect(header.slope).toBe(1);
    expect(header.intercept).toBe(0);
    bytes.writeInt16LE(1, 252); // identity quaternion + negative qfac
    bytes.writeFloatLE(-1, 76);
    bytes.writeFloatLE(12, 268);
    bytes.writeFloatLE(-4, 272);
    bytes.writeFloatLE(8, 276);
    header = parseHeader(bytes, "test");
    expect(header.info.affine).toEqual([
      1, 0, -0, 12, 0, 1, -0, -4, 0, 0, -2, 8,
    ]);
    expect(header.info.hasOrientation).toBe(true);
    bytes.writeInt16LE(1, 254);
    const affine = [-1, 0, 0, 20, 0, 2, 0, 30, 0, 0, 3, 40];
    affine.forEach((n, i) => bytes.writeFloatLE(n, 280 + i * 4));
    expect(parseHeader(bytes, "test").info.affine).toEqual(affine);
  });
  it("checks overlay dimensions and frame compatibility only", () => {
    const info = parseHeader(fixture(), "test").info;
    expect(() =>
      assertOverlayDimensions(info, { ...info, frames: 1 }),
    ).not.toThrow();
    expect(() =>
      assertOverlayDimensions(info, { ...info, dimensions: [2, 2, 2] }),
    ).toThrow("dimensions mismatch");
    expect(() => assertOverlayDimensions(info, { ...info, frames: 3 })).toThrow(
      "frame count mismatch",
    );
    expect(() =>
      assertOverlayDimensions(info, {
        ...info,
        affine: info.affine.map((n, i) => (i === 3 ? n + 10 : n)),
        spatialUnits: 2,
        hasOrientation: !info.hasOrientation,
        spacing: [9, 8, 7],
      }),
    ).not.toThrow();
  });
  it.each([false, true])(
    "inherits the first image's geometry, ignoring invalid overlay geometry (gzip=%s)",
    async (gzip) => {
      const reference = parseHeader(fixture(), "base").info;
      reference.affine = [-1, 0, 0, 20, 0, 2, 0, 30, 0, 0, 3, 40];
      reference.spacing = [1, 2, 3];
      reference.hasOrientation = true;
      reference.spatialUnits = 2;
      const bytes = fixture();
      bytes.writeFloatLE(0, 80); // invalid spacing
      bytes.writeInt16LE(1, 254); // invalid singular sform
      bytes.fill(0, 280, 328);
      bytes.writeFloatLE(3, 112); // preserve the overlay's own intensity scaling
      bytes.writeFloatLE(5, 116);
      expect(() => parseHeader(bytes, "overlay")).toThrow(
        "Invalid voxel spacing",
      );
      const overlay = await volume(bytes, gzip, reference);
      expect(overlay.info).toEqual({ ...reference, name: "test" });
      expect(overlay.info.affine).not.toBe(reference.affine);
      expect(overlay.info.spacing).not.toBe(reference.spacing);
      for (const axis of [0, 1, 2] as const) {
        const pixels = values(
          await overlay.slice({ id: axis + 1, axis, index: 0, frame: 0 }),
        );
        expect(pixels[0]).toBe(5);
        expect(pixels[1]).toBe((axis === 0 ? 3 : 1) * 3 + 5);
      }
      const wrongSize = Buffer.from(bytes);
      wrongSize.writeInt16LE(2, 42);
      await expect(volume(wrongSize, gzip, reference)).rejects.toThrow(
        "dimensions mismatch",
      );
    },
  );
  it("caps oversized planes to 1024 pixels per edge", async () => {
    const bytes = fixture();
    bytes.writeInt16LE(2049, 42);
    bytes.writeInt16LE(1, 44);
    bytes.writeInt16LE(1, 46);
    bytes.writeInt16LE(1, 48);
    const large = Buffer.alloc(352 + 2049 * 2);
    bytes.copy(large, 0, 0, 352);
    for (let i = 0; i < 2049; i++) {
      large.writeInt16LE(i, 352 + i * 2);
    }
    const source = await volume(large);
    const plane = await source.slice({ id: 1, axis: 2, index: 0, frame: 0 });
    expect(plane!.width).toBe(683);
    expect(plane!.height).toBe(1);
    expect(values(plane).slice(0, 3)).toEqual([-3, 3, 9]);
  });
});

it.each([true, false])(
  "reads a full label frame with scaling, frame offsets and endian=%s",
  async (le) => {
    const bytes = fixture(false, le);
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setFloat32(
      116,
      0,
      le,
    );
    const source = await volume(bytes, true);
    expect([...(await source.labelFrame(1))]).toEqual(
      Array.from({ length: 12 }, (_, i) => (i + 12) * 2),
    );
    await expect(source.labelFrame(2)).rejects.toThrow("frame");
  },
);
it("rejects non-label intensities only in the 3D path", async () => {
  const bytes = fixture();
  bytes.writeFloatLE(0.5, 112);
  bytes.writeFloatLE(0, 116);
  const source = await volume(bytes);
  await expect(source.labelFrame(0)).rejects.toThrow(
    "nonnegative integer labels",
  );
  expect(
    await source.slice({ id: 1, axis: 2, index: 0, frame: 0 }),
  ).not.toBeNull();
});

it.each([128, 129])(
  "classifies exactly %s distinct values using the 128-value boundary",
  async (distinct) => {
    const bytes = Buffer.alloc(352 + 256 * 2);
    bytes.writeInt32LE(348, 0);
    bytes.set([110, 43, 49, 0], 344);
    bytes.writeInt16LE(3, 40);
    bytes.writeInt16LE(16, 42);
    bytes.writeInt16LE(16, 44);
    bytes.writeInt16LE(1, 46);
    bytes.writeInt16LE(4, 70);
    bytes.writeInt16LE(16, 72);
    bytes.writeFloatLE(352, 108);
    [80, 84, 88].forEach((offset) => bytes.writeFloatLE(1, offset));
    // A finite non-integer intensity scale must not change the cardinality rule.
    bytes.writeFloatLE(0.5, 112);
    bytes.writeFloatLE(0.25, 116);
    for (let i = 0; i < 256; i++) bytes.writeInt16LE(i % distinct, 352 + i * 2);
    const source = await volume(bytes, true);
    expect(await source.classifySource()).toBe(
      distinct > 128 ? "image" : "mask",
    );
  },
);
it("counts later frames and never infers masks from the first frame alone", async () => {
  const bytes = Buffer.alloc(352 + 256 * 2 * 2);
  bytes.writeInt32LE(348, 0);
  bytes.set([110, 43, 49, 0], 344);
  bytes.writeInt16LE(4, 40);
  [16, 16, 1, 2].forEach((n, i) => bytes.writeInt16LE(n, 42 + i * 2));
  bytes.writeInt16LE(4, 70);
  bytes.writeInt16LE(16, 72);
  bytes.writeFloatLE(352, 108);
  [80, 84, 88].forEach((offset) => bytes.writeFloatLE(1, offset));
  for (let i = 0; i < 256; i++) bytes.writeInt16LE(i, 352 + (256 + i) * 2);
  const source = await volume(bytes);
  expect(await source.classifySource()).toBe("image");
});
it("supports cancellation while classifying a source", async () => {
  const source = await volume(fixture());
  const abort = new AbortController();
  abort.abort();
  await expect(source.classifySource(abort.signal)).rejects.toThrow(
    "cancelled",
  );
});
