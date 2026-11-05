import { triTable } from "three/addons/objects/MarchingCubes.js";

export interface Mesh {
  label: number;
  vertices: Float32Array;
  indices: Uint32Array;
}
interface Bounds {
  min: number[];
  max: number[];
}
interface Row {
  edges: [number[], number[], number[]];
  base: number[];
  lo: number;
  hi: number;
  start: number;
  count: number;
  cellLo: number;
  cellHi: number;
}

// Serial, discrete-label Flying Edges: x-edge classification + trimming,
// yz-edge/triangle counting, prefix allocation, then owned-edge generation.
// Algorithm: https://vtk.org/doc/nightly/html/classvtkFlyingEdges3D.html
// The standard contour case table comes from Three.js (MIT licensed).
// No point locator/merging; each grid edge creates exactly one vertex.
export function flyingEdges(
  labels: Uint32Array,
  dimensions: number[],
  affine: number[],
  progress: (label: number) => void = () => {},
  triangleLimit = 1_000_000,
): Mesh[] {
  const [dx, dy, dz] = dimensions;
  if (labels.length !== dx * dy * dz)
    throw new Error("Mask dimensions mismatch.");
  const bounds = new Map<number, Bounds>();
  for (let z = 0, i = 0; z < dz; z++)
    for (let y = 0; y < dy; y++)
      for (let x = 0; x < dx; x++, i++) {
        const label = labels[i];
        if (!label) continue;
        let b = bounds.get(label);
        if (!b) {
          if (bounds.size >= 128)
            throw new Error("三维 mask 最多支持 128 个标签。");
          bounds.set(label, (b = { min: [x, y, z], max: [x, y, z] }));
        }
        for (const [axis, value] of [x, y, z].entries()) {
          b.min[axis] = Math.min(b.min[axis], value);
          b.max[axis] = Math.max(b.max[axis], value);
        }
      }
  const meshes: Mesh[] = [];
  let totalTriangles = 0;
  for (const [label, boundsForLabel] of [...bounds].sort(
    (a, b) => a[0] - b[0],
  )) {
    progress(label);
    const mesh = contour(label, boundsForLabel, triangleLimit - totalTriangles);
    totalTriangles += mesh.indices.length / 3;
    meshes.push(mesh);
  }
  return meshes;

  function contour(
    label: number,
    boundsForLabel: Bounds,
    budget: number,
  ): Mesh {
    // One zero voxel around every label closes surfaces touching image borders.
    const origin = boundsForLabel.min.map((n) => n - 1);
    const [nx, ny, nz] = boundsForLabel.max.map((n, a) => n - origin[a] + 2);
    const ex = nx - 1;
    if (ex * ny * nz > 80 * 1024 * 1024)
      throw new Error("三维 mask 包围盒过大；二维叠加仍可使用。");
    const cases = new Uint8Array(ex * ny * nz);
    const rows: Row[] = Array.from({ length: ny * nz }, () => ({
      edges: [[], [], []],
      base: [0, 0, 0],
      lo: ex,
      hi: -1,
      start: 0,
      count: 0,
      cellLo: ex,
      cellHi: -1,
    }));
    const inside = (x: number, y: number, z: number) => {
      x += origin[0];
      y += origin[1];
      z += origin[2];
      return x >= 0 &&
        x < dx &&
        y >= 0 &&
        y < dy &&
        z >= 0 &&
        z < dz &&
        labels[x + dx * (y + dy * z)] === label
        ? 1
        : 0;
    };
    // Pass 1: two bits per x-edge, plus row trim bounds.
    for (let z = 0; z < nz; z++)
      for (let y = 0; y < ny; y++) {
        const r = y + ny * z,
          row = rows[r];
        let left = inside(0, y, z);
        for (let x = 0; x < ex; x++) {
          const right = inside(x + 1, y, z);
          cases[r * ex + x] = left | (right << 1);
          if (left !== right) {
            row.edges[0].push(x);
            row.lo = Math.min(row.lo, x);
            row.hi = x;
          }
          left = right;
        }
      }
    const bit = (r: number, x: number) =>
      x < ex ? cases[r * ex + x] & 1 : cases[r * ex + ex - 1] >> 1;
    const cellCase = (r: number, x: number) => {
      const a = cases[r * ex + x],
        b = cases[(r + 1) * ex + x];
      const c = cases[(r + ny) * ex + x],
        d = cases[(r + ny + 1) * ex + x];
      return (
        a |
        ((b & 2) << 1) |
        ((b & 1) << 3) |
        (c << 4) |
        ((d & 2) << 5) |
        ((d & 1) << 7)
      );
    };
    const tableLengths = new Uint8Array(256);
    for (let c = 0; c < 256; c++) {
      let n = 0;
      while (n < 16 && triTable[c * 16 + n] !== -1) n++;
      tableLengths[c] = n;
    }
    let vertices = 0,
      triangles = 0;
    // Pass 2: count owned yz edges and row triangles within computational trims.
    for (let z = 0; z < nz; z++)
      for (let y = 0; y < ny; y++) {
        const r = y + ny * z,
          row = rows[r];
        for (const [axis, next, valid] of [
          [1, r + 1, y + 1 < ny],
          [2, r + ny, z + 1 < nz],
        ] as const) {
          if (!valid) continue;
          const lo = Math.min(row.lo, rows[next].lo),
            hi = Math.max(row.hi, rows[next].hi) + 1;
          for (let x = lo; x <= hi && x < nx; x++)
            if (bit(r, x) !== bit(next, x)) row.edges[axis].push(x);
        }
        vertices += row.edges.reduce((n, e) => n + e.length, 0);
        if (y + 1 < ny && z + 1 < nz) {
          const neighbors = [row, rows[r + 1], rows[r + ny], rows[r + ny + 1]];
          row.cellLo = Math.min(...neighbors.map((n) => n.lo));
          row.cellHi = Math.max(...neighbors.map((n) => n.hi));
          for (let x = row.cellLo; x <= row.cellHi; x++)
            row.count += tableLengths[cellCase(r, x)] / 3;
          triangles += row.count;
        }
        if (triangles > budget || vertices > 2_000_000)
          throw new Error(
            "三维表面超过 100 万三角形或 200 万顶点上限；二维叠加仍可使用。",
          );
      }
    // Pass 3: prefix sums and exact output allocations.
    let vertexOffset = 0,
      triangleOffset = 0;
    for (const row of rows) {
      for (let axis = 0; axis < 3; axis++) {
        row.base[axis] = vertexOffset;
        vertexOffset += row.edges[axis].length;
      }
      row.start = triangleOffset;
      triangleOffset += row.count;
    }
    const points = new Float32Array(vertices * 3);
    const indices = new Uint32Array(triangles * 3);
    const [a, b, c, , d, e, f, , g, h, i] = affine;
    // The case table sets bits for values below its isovalue. Our bits mark
    // foreground instead; reverse that convention, then account for reflection.
    const reverseWinding =
      a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g) > 0;
    function edgeId(r: number, axis: number, x: number): number {
      const edges = rows[r].edges[axis];
      let lo = 0,
        hi = edges.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >>> 1;
        if (edges[mid] === x) return rows[r].base[axis] + mid;
        if (edges[mid] < x) lo = mid + 1;
        else hi = mid - 1;
      }
      throw new Error("Flying Edges topology lookup failed.");
    }
    // Pass 4: interpolate each owned edge once, directly into final arrays.
    for (let z = 0; z < nz; z++)
      for (let y = 0; y < ny; y++) {
        const r = y + ny * z,
          row = rows[r];
        for (let axis = 0; axis < 3; axis++)
          for (let j = 0; j < row.edges[axis].length; j++) {
            const p = [
              row.edges[axis][j] + origin[0],
              y + origin[1],
              z + origin[2],
            ];
            p[axis] += 0.5; // Discrete-label 0.5 contour, not interpolation of label IDs.
            const offset = (row.base[axis] + j) * 3;
            for (let world = 0; world < 3; world++)
              points[offset + world] =
                affine[world * 4] * p[0] +
                affine[world * 4 + 1] * p[1] +
                affine[world * 4 + 2] * p[2] +
                affine[world * 4 + 3];
          }
        let out = row.start * 3;
        for (let x = row.cellLo; x <= row.cellHi; x++) {
          const code = cellCase(r, x),
            n = tableLengths[code];
          if (!n) continue;
          // Standard cube edges -> owning row, grid axis and x coordinate.
          const owners = [
            [r, 0, x],
            [r, 1, x + 1],
            [r + 1, 0, x],
            [r, 1, x],
            [r + ny, 0, x],
            [r + ny, 1, x + 1],
            [r + ny + 1, 0, x],
            [r + ny, 1, x],
            [r, 2, x],
            [r, 2, x + 1],
            [r + 1, 2, x + 1],
            [r + 1, 2, x],
          ];
          for (let t = 0; t < n; t += 3) {
            for (let k = 0; k < 3; k++) {
              const edge =
                triTable[code * 16 + t + (reverseWinding ? 2 - k : k)];
              const [owner, axis, px] = owners[edge];
              indices[out++] = edgeId(owner, axis, px);
            }
          }
        }
      }
    return { label, vertices: points, indices };
  }
}
