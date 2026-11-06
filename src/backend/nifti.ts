import { createReadStream, createWriteStream } from "node:fs";
import { type FileHandle, mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import type {
  Axis,
  SlicePixels,
  SliceRequest,
  VolumeInfo,
  SourceKind,
} from "../protocol";

const BLOCK_BYTES = 256 * 1024;
const CACHE_BLOCKS = 32;
const MAX_EDGE = 1024;
const TYPES: Record<
  number,
  [number, (v: DataView, p: number, le: boolean) => number]
> = {
  2: [1, (v, p) => v.getUint8(p)],
  4: [2, (v, p, le) => v.getInt16(p, le)],
  8: [4, (v, p, le) => v.getInt32(p, le)],
  16: [4, (v, p, le) => v.getFloat32(p, le)],
  64: [8, (v, p, le) => v.getFloat64(p, le)],
  256: [1, (v, p) => v.getInt8(p)],
  512: [2, (v, p, le) => v.getUint16(p, le)],
  768: [4, (v, p, le) => v.getUint32(p, le)],
};

interface Header {
  info: VolumeInfo;
  offset: number;
  datatype: number;
  littleEndian: boolean;
  slope: number;
  intercept: number;
}

type SpatialInfo = Pick<
  VolumeInfo,
  "spacing" | "affine" | "spatialUnits" | "hasOrientation"
>;

/** Single-file scalar NIfTI-1/2; overlays inherit only spatial metadata. */
export function parseHeader(
  bytes: Uint8Array,
  name: string,
  reference?: VolumeInfo,
): Header {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 348) {
    throw new Error("Truncated NIfTI header.");
  }
  const littleEndian = [348, 540].includes(v.getInt32(0, true));
  const version = v.getInt32(0, littleEndian);
  if (version !== 348 && version !== 540) {
    throw new Error("Not a NIfTI-1 or NIfTI-2 file.");
  }
  const v2 = version === 540;
  if (bytes.length < version) {
    throw new Error("Truncated NIfTI header.");
  }
  const magic = v2 ? 4 : 344;
  const signature = v2 ? [110, 43, 50, 0, 13, 10, 26, 10] : [110, 43, 49, 0];
  if (!signature.every((b, i) => bytes[magic + i] === b)) {
    throw new Error(
      "Remote slices require a single-file .nii or .nii.gz volume.",
    );
  }
  const i16 = (p: number) => v.getInt16(p, littleEndian);
  const i32 = (p: number) => v.getInt32(p, littleEndian);
  const i64 = (p: number) => Number(v.getBigInt64(p, littleEndian));
  const real = (p: number) =>
    v2 ? v.getFloat64(p, littleEndian) : v.getFloat32(p, littleEndian);
  const dim = (i: number) => (v2 ? i64(16 + i * 8) : i16(40 + i * 2));
  const ndim = dim(0);
  if (ndim < 2 || ndim > 7) {
    throw new Error("Expected a 2D, 3D or multi-frame NIfTI volume.");
  }
  const allDims = Array.from({ length: ndim }, (_, i) => dim(i + 1));
  if (allDims.some((d) => !Number.isSafeInteger(d) || d < 1)) {
    throw new Error("Invalid NIfTI dimensions.");
  }
  const dimensions = [allDims[0], allDims[1], allDims[2] ?? 1];
  const frames = allDims.slice(3).reduce((a, b) => a * b, 1);
  const datatype = i16(v2 ? 12 : 70);
  const type = TYPES[datatype];
  if (!type || i16(v2 ? 14 : 72) !== type[0] * 8) {
    throw new Error(
      `Unsupported scalar datatype ${datatype}. RGB, complex and 64-bit integers are not supported by remote slices.`,
    );
  }
  const offset = v2 ? i64(168) : real(108);
  const dataBytes = dimensions.reduce((a, b) => a * b, frames * type[0]);
  if (
    !Number.isSafeInteger(offset) ||
    offset < (v2 ? 544 : 352) ||
    !Number.isSafeInteger(offset + dataBytes)
  ) {
    throw new Error("Invalid or unsafe NIfTI data size/offset.");
  }
  // Overlay geometry is intentionally ignored, even when its header contains
  // invalid spacing or transforms. Decode dimensions/intensities from its own
  // header, and locate those voxels using the first image's spatial metadata.
  function readGeometry(): SpatialInfo {
    const pixdim = (i: number) => real((v2 ? 104 : 76) + i * (v2 ? 8 : 4));
    const spacing = [1, 2, 3].map((i) => (i > ndim ? 1 : Math.abs(pixdim(i))));
    if (spacing.some((s) => !Number.isFinite(s) || s <= 0)) {
      throw new Error("Invalid voxel spacing.");
    }
    let affine = [
      spacing[0],
      0,
      0,
      0,
      0,
      spacing[1],
      0,
      0,
      0,
      0,
      spacing[2],
      0,
    ];
    const sform = v2 ? i32(348) : i16(254);
    const qform = v2 ? i32(344) : i16(252);
    if (sform > 0) {
      affine = Array.from({ length: 12 }, (_, i) =>
        real((v2 ? 400 : 280) + i * (v2 ? 8 : 4)),
      );
    } else if (qform > 0) {
      const start = v2 ? 352 : 256;
      const step = v2 ? 8 : 4;
      let [b, c, d] = [0, 1, 2].map((i) => real(start + i * step));
      let a = 1 - b * b - c * c - d * d;
      if (a < 1e-7) {
        const length = Math.hypot(b, c, d);
        b /= length;
        c /= length;
        d /= length;
        a = 0;
      } else {
        a = Math.sqrt(a);
      }
      const rotation = [
        a * a + b * b - c * c - d * d,
        2 * (b * c - a * d),
        2 * (b * d + a * c),
        2 * (b * c + a * d),
        a * a + c * c - b * b - d * d,
        2 * (c * d - a * b),
        2 * (b * d - a * c),
        2 * (c * d + a * b),
        a * a + d * d - c * c - b * b,
      ];
      const qspacing = [...spacing];
      if (pixdim(0) < 0) {
        qspacing[2] *= -1;
      }
      affine = Array.from({ length: 12 }, (_, i) =>
        i % 4 === 3
          ? real(start + (3 + Math.floor(i / 4)) * step)
          : rotation[Math.floor(i / 4) * 3 + (i % 4)] * qspacing[i % 4],
      );
    }
    if (affine.some((n) => !Number.isFinite(n))) {
      throw new Error("Invalid spatial transform.");
    }
    const [a, b, c, , d, e, f, , g, h, i] = affine;
    const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
    if (!Number.isFinite(det) || Math.abs(det) < 1e-12) {
      throw new Error("Singular spatial transform.");
    }
    const spatialSpacing = [0, 1, 2].map((col) =>
      Math.hypot(affine[col], affine[4 + col], affine[8 + col]),
    );
    return {
      spacing: spatialSpacing,
      affine,
      spatialUnits: (v2 ? i32(500) : v.getUint8(123)) & 7,
      hasOrientation: sform > 0 || qform > 0,
    };
  }
  const geometry: SpatialInfo = reference
    ? {
        spacing: [...reference.spacing],
        affine: [...reference.affine],
        spatialUnits: reference.spatialUnits,
        hasOrientation: reference.hasOrientation,
      }
    : readGeometry();
  const rawSlope = real(v2 ? 176 : 112);
  const slope = Number.isFinite(rawSlope) && rawSlope !== 0 ? rawSlope : 1;
  const rawIntercept = real(v2 ? 184 : 116);
  const intercept =
    Number.isFinite(rawSlope) && rawSlope !== 0 && Number.isFinite(rawIntercept)
      ? rawIntercept
      : 0;
  return {
    info: {
      name,
      dimensions,
      frames,
      ...geometry,
    },
    datatype,
    offset,
    littleEndian,
    slope,
    intercept,
  };
}

export function assertOverlayDimensions(
  base: VolumeInfo,
  overlay: VolumeInfo,
): void {
  if (
    base.dimensions.length !== overlay.dimensions.length ||
    base.dimensions.some((d, i) => d !== overlay.dimensions[i])
  ) {
    throw new Error(
      `Overlay dimensions mismatch: expected ${base.dimensions.join(" × ")}, got ${overlay.dimensions.join(" × ")}.`,
    );
  }
  if (overlay.frames !== 1 && overlay.frames !== base.frames) {
    throw new Error(
      `Overlay frame count mismatch: expected 1 or ${base.frames}, got ${overlay.frames}.`,
    );
  }
}

export class RemoteVolume {
  private cache = new Map<number, Buffer>();
  private closed = false;
  private constructor(
    private file: FileHandle,
    private header: Header,
    private scratch?: string,
    readonly hostPath?: string,
  ) {}

  get info(): VolumeInfo {
    return this.header.info;
  }

  static async open(
    path: string,
    name: string,
    signal?: AbortSignal,
    reference?: VolumeInfo,
  ): Promise<RemoteVolume> {
    let scratch: string | undefined;
    let file: FileHandle | undefined;
    try {
      let readable = path;
      if (path.toLowerCase().endsWith(".gz")) {
        scratch = await mkdtemp(join(tmpdir(), "miku-visual-slices-"));
        readable = join(scratch, "volume.nii");
        // Stream on the workspace host; never materialize the volume in the webview.
        await pipeline(
          createReadStream(path),
          createGunzip(),
          createWriteStream(readable, { mode: 0o600 }),
          { signal },
        );
      }
      if (signal?.aborted) {
        throw new Error("Opening cancelled.");
      }
      file = await open(readable, "r");
      const bytes = Buffer.alloc(544);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      const header = parseHeader(bytes.subarray(0, bytesRead), name, reference);
      if (reference) assertOverlayDimensions(reference, header.info);
      const expected =
        header.offset +
        header.info.dimensions.reduce(
          (a, b) => a * b,
          header.info.frames * TYPES[header.datatype][0],
        );
      if ((await file.stat()).size < expected) {
        throw new Error("Truncated NIfTI voxel data.");
      }
      if (signal?.aborted) {
        throw new Error("Opening cancelled.");
      }
      return new RemoteVolume(file, header, scratch, readable);
    } catch (error) {
      await file?.close();
      if (scratch) {
        await rm(scratch, { recursive: true, force: true });
      }
      throw error;
    }
  }

  async dispose(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.cache.clear();
    await this.file.close();
    if (this.scratch) {
      await rm(this.scratch, { recursive: true, force: true });
    }
  }

  private async block(index: number): Promise<Buffer> {
    if (this.closed) {
      throw new Error("Volume closed.");
    }
    let buffer = this.cache.get(index);
    this.cache.delete(index);
    if (!buffer) {
      buffer = Buffer.alloc(BLOCK_BYTES);
      const { bytesRead } = await this.file.read(
        buffer,
        0,
        buffer.length,
        index * BLOCK_BYTES,
      );
      buffer = buffer.subarray(0, bytesRead);
    }
    this.cache.set(index, buffer);
    if (this.cache.size > CACHE_BLOCKS) {
      this.cache.delete(this.cache.keys().next().value!);
    }
    return buffer;
  }

  /** Count across all frames on the host, with a bounded Set and chunk buffer. */
  async classifySource(signal?: AbortSignal): Promise<SourceKind> {
    const count = this.info.dimensions.reduce(
      (a, b) => a * b,
      this.info.frames,
    );
    const [size, read] = TYPES[this.header.datatype];
    const buffer = Buffer.alloc(BLOCK_BYTES);
    const values = new Set<number>();
    for (let start = 0; start < count;) {
      if (signal?.aborted || this.closed)
        throw new Error("Classification cancelled.");
      const length = Math.min(buffer.length / size, count - start);
      const bytes = length * size;
      let done = 0;
      while (done < bytes) {
        const result = await this.file.read(
          buffer,
          done,
          bytes - done,
          this.header.offset + start * size + done,
        );
        if (!result.bytesRead) throw new Error("Truncated voxel data.");
        done += result.bytesRead;
      }
      const view = new DataView(buffer.buffer, buffer.byteOffset, bytes);
      for (let i = 0; i < length; i++) {
        values.add(
          read(view, i * size, this.header.littleEndian) * this.header.slope +
            this.header.intercept,
        );
        if (values.size >= 256) return "image";
      }
      start += length;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    if (signal?.aborted || this.closed)
      throw new Error("Classification cancelled.");
    return "mask";
  }

  /** Full resolution, host-only label frame for surface extraction in a worker. */
  async labelFrame(frame: number): Promise<Uint32Array> {
    if (!Number.isInteger(frame) || frame < 0 || frame >= this.info.frames)
      throw new Error("Invalid mask frame.");
    const count = this.info.dimensions.reduce((a, b) => a * b, 1);
    if (count > 64 * 1024 * 1024)
      throw new Error(
        "3D mask exceeds the 67,108,864-voxel limit; 2D overlays remain available.",
      );
    const labels = new Uint32Array(count);
    const [size, read] = TYPES[this.header.datatype];
    const buffer = Buffer.alloc(BLOCK_BYTES);
    const values = new Set<number>();
    for (let start = 0; start < count;) {
      const length = Math.min(buffer.length / size, count - start);
      const bytes = length * size;
      let done = 0;
      while (done < bytes) {
        const result = await this.file.read(
          buffer,
          done,
          bytes - done,
          this.header.offset + (frame * count + start) * size + done,
        );
        if (!result.bytesRead) throw new Error("Truncated mask data.");
        done += result.bytesRead;
      }
      const view = new DataView(buffer.buffer, buffer.byteOffset, bytes);
      for (let i = 0; i < length; i++) {
        const value =
          read(view, i * size, this.header.littleEndian) * this.header.slope +
          this.header.intercept;
        if (!Number.isInteger(value) || value < 0 || value > 0xffffffff)
          throw new Error(
            "3D surfaces require nonnegative integer labels (0 is background); 2D overlays are unaffected.",
          );
        labels[start + i] = value;
        if (value) {
          values.add(value);
          if (values.size > 255)
            throw new Error(
              "3D mask exceeds the 255-label limit; 2D overlays remain available.",
            );
        }
      }
      start += length;
    }
    return labels;
  }

  async slice(
    request: SliceRequest,
    cancelled: () => boolean = () => false,
  ): Promise<SlicePixels | null> {
    const { axis, index, frame } = request;
    const dims = this.info.dimensions;
    if (
      ![0, 1, 2].includes(axis) ||
      !Number.isInteger(index) ||
      index < 0 ||
      index >= dims[axis] ||
      !Number.isInteger(frame) ||
      frame < 0 ||
      frame >= this.info.frames
    ) {
      throw new Error("Invalid slice coordinates.");
    }
    const [u, v] = (
      [
        [1, 2],
        [0, 2],
        [0, 1],
      ] as const
    )[axis as Axis];
    const stepU = Math.max(1, Math.ceil(dims[u] / MAX_EDGE));
    const stepV = Math.max(1, Math.ceil(dims[v] / MAX_EDGE));
    const width = Math.ceil(dims[u] / stepU),
      height = Math.ceil(dims[v] / stepV);
    const pixels = Buffer.alloc(width * height * 4);
    const [bytesPerVoxel, read] = TYPES[this.header.datatype];
    const strides = [1, dims[0], dims[0] * dims[1]];
    const start = frame * dims[0] * dims[1] * dims[2] + index * strides[axis];
    let min = Infinity,
      max = -Infinity,
      blockIndex = -1;
    let data: Buffer = Buffer.alloc(0),
      view = new DataView(data.buffer);
    for (let y = 0; y < height; y++) {
      if (cancelled() || this.closed) {
        return null;
      }
      // Yield even on cache hits so navigation/disposal can cancel a large slice.
      if (y % 32 === 0) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      for (let x = 0; x < width; x++) {
        const position =
          this.header.offset +
          (start + y * stepV * strides[v] + x * stepU * strides[u]) *
            bytesPerVoxel;
        const next = Math.floor(position / BLOCK_BYTES);
        if (next !== blockIndex) {
          if (cancelled() || this.closed) {
            return null;
          }
          data = await this.block(next);
          view = new DataView(data.buffer, data.byteOffset, data.byteLength);
          blockIndex = next;
        }
        const local = position % BLOCK_BYTES;
        let value: number;
        if (local + bytesPerVoxel <= data.length) {
          value = read(view, local, this.header.littleEndian);
        } else {
          const one = Buffer.alloc(bytesPerVoxel);
          await this.file.read(one, 0, one.length, position);
          value = read(
            new DataView(one.buffer, one.byteOffset, one.length),
            0,
            this.header.littleEndian,
          );
        }
        value = Math.fround(value * this.header.slope + this.header.intercept);
        // Explicit little endian Float32 wire encoding, independent of the host.
        pixels.writeFloatLE(value, (y * width + x) * 4);
        if (Number.isFinite(value)) {
          min = Math.min(min, value);
          max = Math.max(max, value);
        }
      }
    }
    return {
      width,
      height,
      pixels: pixels.toString("base64"),
      min: Number.isFinite(min) ? min : 0,
      max: Number.isFinite(max) ? max : 1,
    };
  }
}
