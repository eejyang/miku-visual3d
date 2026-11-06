import { expect, it } from "vitest";
import { createHash } from "node:crypto";
import reference from "./fixtures/flying-edges-vtk.json";
import { flyingEdges, type Mesh } from "../src/backend/flyingEdges";

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
function triangleHash(mesh: Mesh) {
  const triangles: string[] = [];
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const points: string[] = [];
    for (let j = 0; j < 3; j++) {
      const p = mesh.indices[i + j] * 3;
      points.push(
        Array.from(mesh.vertices.slice(p, p + 3), (v) =>
          String(Math.round(v * 2)),
        ).join(","),
      );
    }
    triangles.push(points.sort().join(";"));
  }
  return createHash("sha256").update(triangles.sort().join("\n")).digest("hex");
}
it.each(reference.cases)(
  "matches VTK discrete Flying Edges: $name",
  (fixture) => {
    const meshes = flyingEdges(
      Uint32Array.from(fixture.labels),
      fixture.dimensions,
      identity,
    );
    expect(
      meshes.map((mesh) => ({
        label: mesh.label,
        vertices: mesh.vertices.length / 3,
        triangles: mesh.indices.length / 3,
        sha256: triangleHash(mesh),
      })),
    ).toEqual(fixture.meshes);
  },
);
it("closes image boundaries, shares edge vertices and preserves reflected/sheared base coordinates", () => {
  const affine = [-2, 0.5, 0, 10, 0, 3, 0, -2, 0, 0, 4, 7];
  const [mesh] = flyingEdges(new Uint32Array([4]), [1, 1, 1], affine);
  expect(mesh.vertices.length / 3).toBe(6);
  expect(mesh.indices.length / 3).toBe(8);
  const vertices = Array.from({ length: 6 }, (_, i) => [
    ...mesh.vertices.slice(i * 3, i * 3 + 3),
  ]);
  expect(vertices).toEqual(
    expect.arrayContaining([
      [11, -2, 7],
      [9, -2, 7],
      [9.75, -3.5, 7],
      [10.25, -0.5, 7],
      [10, -2, 5],
      [10, -2, 9],
    ]),
  );
  const uses = new Map<string, number>();
  let volume = 0;
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const indices = [...mesh.indices.slice(i, i + 3)];
    for (let j = 0; j < 3; j++) {
      const key = [indices[j], indices[(j + 1) % 3]]
        .sort((a, b) => a - b)
        .join(":");
      uses.set(key, (uses.get(key) || 0) + 1);
    }
    const [a, b, c] = indices.map((id) =>
      vertices[id].map((v, j) => v - affine[j * 4 + 3]),
    );
    volume +=
      (a[0] * (b[1] * c[2] - b[2] * c[1]) +
        a[1] * (b[2] * c[0] - b[0] * c[2]) +
        a[2] * (b[0] * c[1] - b[1] * c[0])) /
      6;
  }
  expect([...uses.values()].every((n) => n === 2)).toBe(true);
  expect(volume).toBeCloseTo(4); // One-voxel octahedron volume 1/6 * |det affine|.
});
it("handles empty masks", () => {
  expect(flyingEdges(new Uint32Array(8), [2, 2, 2], identity)).toEqual([]);
});

it("extracts surfaces beyond the former triangle and vertex limits", () => {
  // Separated foreground voxels each produce six vertices and eight triangles.
  const edge = 140;
  const labels = new Uint32Array(edge ** 3);
  for (let z = 0; z < edge; z += 2)
    for (let y = 0; y < edge; y += 2)
      for (let x = 0; x < edge; x += 2)
        labels[x + edge * (y + edge * z)] = 1;
  const [mesh] = flyingEdges(labels, [edge, edge, edge], identity);
  const voxels = (edge / 2) ** 3;
  expect(mesh.vertices.length / 3).toBe(voxels * 6); // 2,058,000 vertices.
  expect(mesh.indices.length / 3).toBe(voxels * 8); // 2,744,000 triangles.
}, 30_000);

it("renders 255 distinct labels and rejects masks beyond the label limit", () => {
  const labels = Uint32Array.from({ length: 255 }, (_, i) => i + 1);
  expect(
    flyingEdges(labels, [255, 1, 1], identity).map((mesh) => mesh.label),
  ).toEqual([...labels]);
  expect(() =>
    flyingEdges(
      Uint32Array.from({ length: 256 }, (_, i) => i + 1),
      [256, 1, 1],
      identity,
    ),
  ).toThrow("255 labels");
});
