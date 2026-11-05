import { expect, it } from "vitest";
import { describePlanes, directionLabel } from "../src/webview/orientation";
import type { VolumeInfo } from "../src/protocol";

function volume(affine: number[], hasOrientation = true): VolumeInfo {
  return {
    name: "image",
    dimensions: [17, 32, 48],
    spacing: [1, 1, 1],
    frames: 1,
    affine,
    hasOrientation,
    spatialUnits: 2,
  };
}

it.each([
  [0, 1, 2],
  [0, 2, 1],
  [1, 0, 2],
  [1, 2, 0],
  [2, 0, 1],
  [2, 1, 0],
])(
  "names and arranges anatomical planes for voxel-axis permutation %j",
  (...order) => {
    // Exercise all axis permutations, anisotropic spacing and a reflection.
    const affine = Array(12).fill(0);
    order.forEach((world, voxel) => {
      affine[world * 4 + voxel] = [-2, 3, 4][voxel];
    });
    const planes = describePlanes(volume(affine));
    expect(planes.map((p) => p.axis)).toEqual([
      order.indexOf(2),
      order.indexOf(0),
      order.indexOf(1),
    ]);
    expect(planes.map((p) => p.title)).toEqual(["轴位", "矢状位", "冠状位"]);
    expect(planes.map((p) => p.note)).toEqual(["", "", ""]);
  },
);

it("marks oblique acquisition planes instead of presenting them as orthogonal reslices", () => {
  const angle = Math.PI / 9,
    c = Math.cos(angle),
    s = Math.sin(angle);
  const planes = describePlanes(volume([1, 0, 0, 0, 0, c, -s, 0, 0, s, c, 0]));
  expect(planes.map((p) => [p.title, p.note])).toEqual([
    ["轴位", "斜切"],
    ["矢状位", ""],
    ["冠状位", "斜切"],
  ]);
});

it("uses plane normals for shear, and declines a misleading forced anatomical name", () => {
  const planes = describePlanes(volume([1, 0, 0, 0, 2, 1, 0, 0, 0, 0, 1, 0]));
  // The first voxel direction is mostly anterior, but its constant-index
  // plane is spanned by anterior/superior vectors: an exact sagittal plane.
  expect(planes[1]).toMatchObject({ axis: 0, title: "矢状位", note: "" });
  expect(planes[2]).toMatchObject({ title: "斜切面 3", note: "斜切" });
});

it("does not invent anatomical names or side labels when orientation is missing", () => {
  const image = volume([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0], false);
  expect(describePlanes(image).map((p) => p.title)).toEqual([
    "切面 1",
    "切面 2",
    "切面 3",
  ]);
  expect(describePlanes(image).every((p) => p.note === "方向未知")).toBe(true);
  expect(directionLabel(image, 0, 1)).toBe("");
});

it("retains RAS anatomical side labels, including the inferior I label", () => {
  const image = volume([-2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 4, 0]);
  expect(directionLabel(image, 0, 1)).toBe("L");
  expect(directionLabel(image, 1, 1)).toBe("A");
  expect(directionLabel(image, 2, -1)).toBe("I");
});
