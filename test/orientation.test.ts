import { expect, it } from "vitest";
import {
  describePlanes,
  directionLabel,
  displayDirections,
  voxelToScreen,
  screenToVoxel,
} from "../src/webview/orientation";
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

it("keeps radiological screen directions and reversible positioning for all 48 signed axis permutations", () => {
  const orders = [
    [0, 1, 2],
    [0, 2, 1],
    [1, 0, 2],
    [1, 2, 0],
    [2, 0, 1],
    [2, 1, 0],
  ];
  for (const order of orders)
    for (let signs = 0; signs < 8; signs++) {
      const affine = Array(12).fill(0);
      order.forEach((world, voxel) => {
        affine[world * 4 + voxel] =
          (signs & (1 << voxel) ? -1 : 1) * [2, 3, 4][voxel];
      });
      const image = volume(affine);
      const planes = describePlanes(image);
      expect(planes.map((p) => displayDirections(image, p.display))).toEqual([
        { left: "R", right: "L", top: "A", bottom: "P" },
        { left: "A", right: "P", top: "S", bottom: "I" },
        { left: "R", right: "L", top: "S", bottom: "I" },
      ]);
      for (const { display } of planes) {
        for (let u = 0; u < image.dimensions[display.u]; u++)
          for (let v = 0; v < image.dimensions[display.v]; v++) {
            const indices = [0, 0, 0];
            indices[display.u] = u;
            indices[display.v] = v;
            const [x, y] = voxelToScreen(display, image.dimensions, indices);
            expect(screenToVoxel(display, image.dimensions, x, y)).toEqual([
              u,
              v,
            ]);
          }
        // Outside-image clicks clamp to edges without wrapping after reflection.
        expect(screenToVoxel(display, image.dimensions, -1, -1)).toEqual([
          display.flipU ? image.dimensions[display.u] - 1 : 0,
          display.flipV ? 0 : image.dimensions[display.v] - 1,
        ]);
      }
    }
});

it("preserves uncertainty for oblique and missing orientation", () => {
  const angle = Math.PI / 9,
    c = Math.cos(angle),
    s = Math.sin(angle);
  const oblique = volume([1, 0, 0, 0, 0, c, -s, 0, 0, s, c, 0]);
  const axial = describePlanes(oblique)[0];
  expect(displayDirections(oblique, axial.display)).toEqual({
    left: "R",
    right: "L",
    top: "≈A",
    bottom: "≈P",
  });
  const unknown = { ...oblique, hasOrientation: false };
  expect(
    displayDirections(unknown, describePlanes(unknown)[0].display),
  ).toEqual({ left: "", right: "", top: "", bottom: "" });
});
