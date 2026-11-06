import type { Axis, VolumeInfo } from "../protocol";

export const SLICE_AXES: readonly [Axis, Axis][] = [
  [1, 2],
  [0, 2],
  [0, 1],
];
type View = "axial" | "sagittal" | "coronal";
export interface PlaneDisplay {
  u: Axis;
  v: Axis;
  flipU: boolean;
  flipV: boolean;
}
export interface PlaneDescription {
  axis: Axis;
  view: View;
  title: string;
  english: string;
  note: string;
  display: PlaneDisplay;
}
const views = [
  { view: "axial", world: 2, title: "轴位", english: "Axial" },
  { view: "sagittal", world: 0, title: "矢状位", english: "Sagittal" },
  { view: "coronal", world: 1, title: "冠状位", english: "Coronal" },
] as const;
const permutations: Axis[][] = [
  [0, 1, 2],
  [0, 2, 1],
  [1, 0, 2],
  [1, 2, 0],
  [2, 0, 1],
  [2, 1, 0],
];

/** Orient native pixels for radiological viewing without changing the volume
 * affine or resampling oblique acquisitions. Horizontal points right; vertical
 * points up. NIfTI world coordinates are RAS. */
function displayOrientation(
  volume: VolumeInfo,
  axis: Axis,
  view: View,
): PlaneDisplay {
  const [a, b] = SLICE_AXES[axis];
  if (!volume.hasOrientation) return { u: a, v: b, flipU: false, flipV: false };
  const [horizontal, vertical] =
    view === "axial" ? [0, 1] : view === "sagittal" ? [1, 2] : [0, 2];
  const component = (voxel: Axis, world: number) =>
    volume.affine[world * 4 + voxel];
  const alignment = (voxel: Axis, world: number) =>
    Math.abs(component(voxel, world)) /
    Math.hypot(...[0, 1, 2].map((row) => component(voxel, row)));
  const transpose =
    alignment(b, horizontal) + alignment(a, vertical) >
    alignment(a, horizontal) + alignment(b, vertical);
  const [u, v] = transpose ? [b, a] : [a, b];
  return {
    u,
    v,
    flipU: component(u, horizontal) > 0,
    flipV: component(v, vertical) < 0,
  };
}

export function displayDirections(volume: VolumeInfo, display: PlaneDisplay) {
  return {
    left: directionLabel(volume, display.u, display.flipU ? 1 : -1),
    right: directionLabel(volume, display.u, display.flipU ? -1 : 1),
    top: directionLabel(volume, display.v, display.flipV ? -1 : 1),
    bottom: directionLabel(volume, display.v, display.flipV ? 1 : -1),
  };
}

/** Screen coordinates are normalized, with their origin at the top left. */
export function voxelToScreen(
  display: PlaneDisplay,
  dimensions: readonly number[],
  indices: readonly number[],
): [number, number] {
  const x = (indices[display.u] + 0.5) / dimensions[display.u];
  const y = (indices[display.v] + 0.5) / dimensions[display.v];
  return [display.flipU ? 1 - x : x, display.flipV ? y : 1 - y];
}

export function screenToVoxel(
  display: PlaneDisplay,
  dimensions: readonly number[],
  x: number,
  y: number,
): [number, number] {
  const pixel = (position: number, axis: Axis) =>
    Math.max(
      0,
      Math.min(dimensions[axis] - 1, Math.floor(position * dimensions[axis])),
    );
  const u = pixel(x, display.u),
    v = pixel(y, display.v);
  return [
    display.flipU ? dimensions[display.u] - 1 - u : u,
    display.flipV ? v : dimensions[display.v] - 1 - v,
  ];
}

/** NIfTI sform/qform uses RAS world coordinates. Classify the actual slice
 * normals, rather than assuming that voxel I/J/K are anatomical X/Y/Z.
 * Cross products remain valid for sheared affine matrices as well. */
export function describePlanes(volume: VolumeInfo): PlaneDescription[] {
  if (!volume.hasOrientation) {
    return views.map((view, i) => ({
      ...view,
      axis: ([2, 0, 1] as Axis[])[i],
      title: `切面 ${i + 1}`,
      english: "",
      note: "Unknown orientation",
      display: displayOrientation(volume, ([2, 0, 1] as Axis[])[i], view.view),
    }));
  }
  const column = (axis: Axis) =>
    [0, 1, 2].map((row) => volume.affine[row * 4 + axis]);
  const normals = SLICE_AXES.map(([u, v]) => {
    const a = column(u),
      b = column(v);
    const cross = [
      a[1] * b[2] - a[2] * b[1],
      a[2] * b[0] - a[0] * b[2],
      a[0] * b[1] - a[1] * b[0],
    ];
    const length = Math.hypot(...cross);
    return cross.map((n) => Math.abs(n / length));
  });
  const score = (axes: Axis[]) =>
    views.reduce((sum, view, i) => sum + normals[axes[i]][view.world], 0);
  const assigned = permutations.reduce((best, axes) =>
    score(axes) > score(best) ? axes : best,
  );
  return views.map((view, i) => {
    const axis = assigned[i],
      alignment = normals[axis][view.world];
    // Do not force an anatomical name onto a plane over 45° from that plane.
    const ambiguous = alignment < Math.SQRT1_2;
    return {
      axis,
      view: view.view,
      title: ambiguous ? `斜切面 ${i + 1}` : view.title,
      english: ambiguous ? "Oblique" : view.english,
      note: alignment < Math.cos(Math.PI / 360) ? "Oblique" : "",
      display: displayOrientation(volume, axis, view.view),
    };
  });
}

export function directionLabel(
  volume: VolumeInfo,
  column: number,
  sign: number,
): string {
  if (!volume.hasOrientation) return "";
  const vec = [0, 1, 2].map((row) => volume.affine[row * 4 + column] * sign);
  const major = vec.reduce(
    (best, n, i) => (Math.abs(n) > Math.abs(vec[best]) ? i : best),
    0,
  );
  const label = (vec[major] > 0 ? ["R", "A", "S"] : ["L", "P", "I"])[major];
  return Math.abs(vec[major]) / Math.hypot(...vec) > 0.9999
    ? label
    : `≈${label}`;
}
