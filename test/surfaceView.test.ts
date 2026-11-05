// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Group, Scene, Mesh } from "three";
import { SurfaceView } from "../src/webview/surface";
import type { OverlayLayer, SurfaceMesh } from "../src/protocol";

const state = vi.hoisted(() => ({ scene: undefined as Scene | undefined }));
vi.mock("three", async (original) => {
  const three = await original<typeof import("three")>();
  return {
    ...three,
    WebGLRenderer: class {
      domElement = document.createElement("canvas");
      setPixelRatio() {}
      setSize() {}
      setRenderTarget() {}
      dispose() {}
      render(scene: Scene) {
        state.scene = scene;
      }
      readRenderTargetPixels(
        _target: unknown,
        _x: number,
        _y: number,
        _width: number,
        _height: number,
        pixels: Uint8Array,
      ) {
        pixels.fill(255);
      }
    },
  };
});
const infos: OverlayLayer[] = ["GT.nii.gz", "Prediction.nii.gz"].map(
  (name, i) => ({
    id: `mask-${i + 1}`,
    volume: {
      name,
      dimensions: [2, 2, 2],
      frames: 1,
      spacing: [1, 1, 1],
      affine: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0],
      spatialUnits: 2,
      hasOrientation: true,
    },
  }),
);
function mesh(label: number): SurfaceMesh {
  const vertices = Buffer.alloc(36),
    indices = Buffer.alloc(12);
  [0, 0, 0, 1, 0, 0, 0, 1, 0].forEach((n, i) =>
    vertices.writeFloatLE(n, i * 4),
  );
  [0, 1, 2].forEach((n, i) => indices.writeUInt32LE(n, i * 4));
  return {
    label,
    vertices: vertices.toString("base64"),
    indices: indices.toString("base64"),
  };
}
function row(id: number) {
  return document.querySelector<HTMLElement>(`[data-layer-id="mask-${id}"]`)!;
}
function control(id: number, name: string) {
  return row(id).querySelector<HTMLInputElement>(`.surface-${name}`)!;
}
function change(id: number, name: string, value: string | boolean) {
  const input = control(id, name);
  if (typeof value === "boolean") input.checked = value;
  else input.value = value;
  input.dispatchEvent(
    new Event(typeof value === "boolean" ? "change" : "input"),
  );
}
let view: SurfaceView;
let post: ReturnType<typeof vi.fn>;
beforeEach(() => {
  document.body.innerHTML =
    '<details id="surfaceManager"><span id="surfaceLayerCount"></span><div id="surfaceLayers"></div></details><button id="resetSurface"></button><button id="rebuildSurface"></button><input id="frame" value="0"><div id="renderViewport"><p id="renderMessage"></p><span id="renderCount"></span><div id="renderLegend"></div></div>';
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
    unobserve() {}
  };
  post = vi.fn();
  view = new SurfaceView(document.getElementById("renderViewport")!, post);
  view.setLayers(infos);
});
afterEach(() => {
  window.dispatchEvent(new Event("pagehide"));
  vi.restoreAllMocks();
});
const objects = () => (state.scene!.children[0] as Group).children as Group[];
const ready = (id: string, revision = 1) =>
  view.update(id, revision, {
    state: "ready",
    frame: 0,
    meshes: [mesh(1), mesh(2)],
  });

it("retains both same-label sources and applies visibility, color, opacity and wireframe independently", () => {
  ready("mask-1");
  ready("mask-2");
  expect(objects()).toHaveLength(2);
  expect(objects().map((g) => g.children.length)).toEqual([2, 2]);
  const [gt, pred] = objects();
  const gtMesh = gt.children[0] as Mesh,
    predMesh = pred.children[0] as Mesh;
  expect(gtMesh.material.color.getHexString()).not.toBe(
    predMesh.material.color.getHexString(),
  );
  change(1, "name", "GT");
  expect(document.querySelector("#renderLegend button")!.textContent).toBe(
    "● GT",
  );
  change(1, "color", "#ff0000");
  change(1, "opacity", "0.25");
  change(1, "wireframe", true);
  change(1, "visible", false);
  expect(gt.visible).toBe(false);
  expect(pred.visible).toBe(true);
  expect(gtMesh.material.color.getHexString()).toBe("ff0000");
  expect(gtMesh.material.opacity).toBe(0.25);
  expect(gtMesh.material.wireframe).toBe(true);
  expect(predMesh.material.opacity).toBe(0.65);
  expect(predMesh.material.wireframe).toBe(false);
  row(1).querySelector<HTMLButtonElement>(".surface-labels button")!.click();
  expect(gtMesh.visible).toBe(false);
  expect(predMesh.visible).toBe(true);
  const messages = post.mock.calls.map(([message]) => message);
  expect(
    messages.filter((m) => m.type === "surfacePainted").map((m) => m.layerId),
  ).toEqual(["mask-1", "mask-2"]);
  expect(messages.every((m) => m.type === "surfacePainted")).toBe(true);
});

it("rebuilds only one source, preserving settings and the other source's geometry", () => {
  ready("mask-1");
  ready("mask-2");
  const pred = objects()[1].children[0];
  change(1, "color", "#000000");
  change(1, "opacity", "0");
  change(1, "wireframe", true);
  change(1, "visible", false);
  row(1).querySelector<HTMLButtonElement>(".surface-labels button")!.click();
  view.update("mask-1", 2, { state: "loading", message: "loading" });
  ready("mask-1", 2);
  const gt = objects()[0].children[0] as Mesh;
  expect(objects()[1].children[0]).toBe(pred);
  expect(gt.material.color.getHexString()).toBe("000000");
  expect(gt.material.opacity).toBe(0);
  expect(gt.material.wireframe).toBe(true);
  expect(gt.visible).toBe(false);
  expect(objects()[0].visible).toBe(false);
  expect(control(1, "color").value).toBe("#000000");
  view.update("mask-1", 1, { state: "error", message: "stale" });
  expect(objects()[0].children[0]).toBe(gt);
  expect(
    row(1).querySelector(".surface-layer-status")!.textContent,
  ).not.toContain("stale");
});

it("isolates errors and removes only the requested source and its GPU resources", () => {
  ready("mask-1");
  ready("mask-2");
  const gt = objects()[0].children[0] as Mesh;
  const dispose = vi.spyOn(gt.geometry, "dispose");
  const pred = objects()[1].children[0];
  view.update("mask-1", 2, { state: "error", message: "invalid mask" });
  expect(dispose).toHaveBeenCalledOnce();
  expect(objects()[1].children[0]).toBe(pred);
  expect(row(1).querySelector(".surface-layer-status")!.textContent).toContain(
    "invalid mask",
  );
  expect(document.getElementById("renderMessage")!.hidden).toBe(true);
  row(1).querySelector<HTMLButtonElement>(".surface-remove")!.click();
  expect(post).toHaveBeenCalledWith({
    type: "removeOverlay",
    layerId: "mask-1",
  });
  view.setLayers([infos[1]]);
  expect(objects()).toHaveLength(1);
  expect(objects()[0].children[0]).toBe(pred);
  expect(document.querySelector('[data-layer-id="mask-1"]')).toBeNull();
  ready("mask-1", 3);
  expect(objects()).toHaveLength(1);
});
