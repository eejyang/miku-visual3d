// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  Vector3,
  type Group,
  type Scene,
  type Mesh,
  type PerspectiveCamera,
} from "three";
import { SurfaceView } from "../src/webview/surface";
import type { OverlayLayer, SurfaceMesh } from "../src/protocol";

const state = vi.hoisted(() => ({
  scene: undefined as Scene | undefined,
  camera: undefined as PerspectiveCamera | undefined,
}));
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
      render(scene: Scene, camera: PerspectiveCamera) {
        state.scene = scene;
        state.camera = camera;
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
  if (typeof value === "boolean") {
    if ((input.getAttribute("aria-pressed") === "true") !== value)
      input.click();
    return;
  }
  input.value = value;
  input.dispatchEvent(
    new Event(typeof value === "boolean" ? "change" : "input"),
  );
}
let view: SurfaceView;
let post: ReturnType<typeof vi.fn>;
let locate: ReturnType<typeof vi.fn>;
beforeEach(() => {
  document.body.innerHTML =
    '<div id="surfaceLayers"></div><button id="resetSurface"></button><input id="frame" value="0"><div id="renderViewport"><p id="renderMessage"></p></div>';
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
    unobserve() {}
  };
  post = vi.fn();
  locate = vi.fn();
  view = new SurfaceView(
    document.getElementById("renderViewport")!,
    post,
    () => {},
    locate,
  );
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
  expect(gtMesh.material.color.getHexString()).toBe(
    predMesh.material.color.getHexString(),
  );
  expect(gtMesh.material.color.getHexString()).not.toBe(
    (gt.children[1] as Mesh).material.color.getHexString(),
  );
  expect(row(1).tagName).toBe("DETAILS");
  expect(row(1).querySelector(".surface-filename")!.textContent).toBe(
    "GT.nii.gz",
  );
  expect(row(1).querySelector(".surface-label-count")!.textContent).toBe(
    "· 2 labels",
  );
  expect(row(1).querySelector(".surface-name")).toBeNull();
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
  row(1).querySelector<HTMLButtonElement>(".surface-label-toggle")!.click();
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
  (row(1) as HTMLDetailsElement).open = false;
  row(1).querySelector<HTMLButtonElement>(".surface-rebuild")!.click();
  expect(post).toHaveBeenCalledWith({
    type: "surface",
    layerId: "mask-1",
    frame: 0,
    force: true,
  });
  expect((row(1) as HTMLDetailsElement).open).toBe(false);
  change(1, "color", "#000000");
  change(1, "opacity", "0");
  change(1, "wireframe", true);
  change(1, "visible", false);
  row(1).querySelector<HTMLButtonElement>(".surface-label-toggle")!.click();
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
  view.setLayers(infos);
  expect((row(1) as HTMLDetailsElement).open).toBe(false);
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

it("restores automatic label colors after a manual file-color override", () => {
  ready("mask-1");
  ready("mask-2");
  expect(control(1, "color").disabled).toBe(true);
  const [gt, pred] = objects();
  const mode = row(1).querySelector<HTMLSelectElement>(".surface-color-mode")!;
  mode.value = "#ef4444";
  mode.dispatchEvent(new Event("change"));
  expect(control(1, "color").value).toBe("#ef4444");
  expect((gt.children[0] as Mesh).material.color.getHexString()).toBe("ef4444");
  expect((gt.children[1] as Mesh).material.color.getHexString()).toBe("ef4444");
  expect((pred.children[0] as Mesh).material.color.getHexString()).not.toBe(
    "ef4444",
  );
  change(1, "color", "#ff0000");
  expect(mode.value).toBe("custom");
  expect((gt.children[0] as Mesh).material.color.getHexString()).toBe("ff0000");
  expect((gt.children[1] as Mesh).material.color.getHexString()).toBe("ff0000");
  mode.value = "auto";
  mode.dispatchEvent(new Event("change"));
  expect(control(1, "color").disabled).toBe(true);
  expect((gt.children[0] as Mesh).material.color.getHexString()).toBe(
    (pred.children[0] as Mesh).material.color.getHexString(),
  );
  expect((gt.children[0] as Mesh).material.color.getHexString()).not.toBe(
    (gt.children[1] as Mesh).material.color.getHexString(),
  );
});

it("selects labels independently of visibility and locates world-space bounds through the Mask affine", () => {
  const affine = [0, -2, 0.5, 100, 3, 0, 0, -50, 0, 0, 4, 20];
  view.setLayers([
    {
      ...infos[0],
      volume: { ...infos[0].volume, affine, dimensions: [10, 10, 10] },
    },
  ]);
  const data = mesh(7);
  const vertices = Buffer.alloc(36);
  [97.5, -47, 32, 97.5, -35, 32, 91.5, -47, 48].forEach((value, i) =>
    vertices.writeFloatLE(value, i * 4),
  );
  data.vertices = vertices.toString("base64");
  view.update("mask-1", 1, { state: "ready", frame: 0, meshes: [data] });
  view.setActiveLayer("mask-1");
  expect(row(1).querySelector(".surface-locate")).toBeNull();
  const select = row(1).querySelector<HTMLButtonElement>(
    ".surface-label-select",
  )!;
  select.click();
  expect(select.getAttribute("aria-pressed")).toBe("true");
  const object = objects()[0].children[0] as Mesh;
  expect(object.visible).toBe(true);
  change(1, "visible", false);
  row(1).querySelector<HTMLButtonElement>(".surface-label-toggle")!.click();
  select.dispatchEvent(new MouseEvent("dblclick"));
  expect(locate).toHaveBeenCalledOnce();
  expect(locate.mock.calls[0][0]).toBe("mask-1");
  locate.mock.calls[0][1].forEach((n: number, i: number) =>
    expect(n).toBeCloseTo([3, 4, 5][i], 6),
  );
  const projected = new Vector3(94.5, -41, 40).project(state.camera!);
  expect(projected.x).toBeCloseTo(0, 6);
  expect(projected.y).toBeCloseTo(0, 6);
  expect(objects()[0].visible).toBe(false);
  expect(object.visible).toBe(false);
  expect(view.displayStyle("mask-1")!.hiddenLabels.has(7)).toBe(true);
  select.dispatchEvent(new MouseEvent("dblclick"));
  expect(locate).toHaveBeenCalledTimes(2);
  view.update("mask-1", 2, { state: "loading", message: "loading" });
  select.dispatchEvent(new MouseEvent("dblclick"));
  expect(locate).toHaveBeenCalledTimes(2);
  ready("mask-1", 2);
  select.dispatchEvent(new MouseEvent("dblclick"));
  expect(locate).toHaveBeenCalledTimes(2); // label 7 is absent in this frame.
});

it("keeps first-line controls on collapse, preserves display settings and rejects singular localization", () => {
  const original = {
    ...infos[0],
    volume: { ...infos[0].volume, affine: new Array(12).fill(0) },
  };
  view.setLayers([original]);
  ready("mask-1");
  const select = row(1).querySelector<HTMLButtonElement>(
    ".surface-label-select",
  )!;
  select.click();
  select.dispatchEvent(new MouseEvent("dblclick"));
  expect(locate).not.toHaveBeenCalled();
  const summary = row(1).querySelector("summary")!;
  for (const selector of [
    ".surface-visible",
    ".surface-opacity",
    ".surface-solid",
    ".surface-wireframe",
    ".surface-rebuild",
    ".surface-remove",
  ])
    expect(summary.querySelector(selector)).not.toBeNull();
  expect(summary.querySelector(".surface-color-mode")).toBeNull();
  expect(
    row(1).querySelector(".surface-label-controls .surface-color-mode"),
  ).not.toBeNull();
  (row(1) as HTMLDetailsElement).open = false;
  change(1, "opacity", "0.2");
  change(1, "wireframe", true);
  change(1, "color", "#ff0000");
  change(1, "visible", false);
  expect(control(1, "visible").title).toBe("显示标签");
  change(1, "visible", true);
  expect(control(1, "visible").title).toBe("隐藏标签");
  const object = objects()[0].children[0] as Mesh;
  expect(object.material.opacity).toBe(0.2);
  expect(object.material.color.getHexString()).toBe("ff0000");
  expect(object.material.wireframe).toBe(true);
  expect(control(1, "solid").getAttribute("aria-pressed")).toBe("false");
  control(1, "solid").click();
  expect(object.material.wireframe).toBe(false);
  expect(control(1, "wireframe").getAttribute("aria-pressed")).toBe("false");
  expect((row(1) as HTMLDetailsElement).open).toBe(false);
});

it("projects the linked voxel through its reference affine and follows camera zoom without changing surfaces", () => {
  const viewport = document.getElementById("renderViewport")!;
  Object.defineProperties(viewport, {
    clientWidth: { value: 400 },
    clientHeight: { value: 300 },
  });
  const volume = {
    ...infos[0].volume,
    affine: [0, -2, 0.5, 100, 3, 0, 0, -50, 0, 0, 4, 20],
  };
  view.setCrosshair(volume, [3, 4, 5], true);
  const guides = viewport.querySelector<HTMLElement>(".crosshair")!;
  expect(guides.hidden).toBe(true); // No surface camera exists yet.
  const data = mesh(7),
    vertices = Buffer.alloc(36);
  [97.5, -47, 32, 97.5, -35, 32, 91.5, -47, 48].forEach((n, i) =>
    vertices.writeFloatLE(n, i * 4),
  );
  data.vertices = vertices.toString("base64");
  view.update("mask-1", 1, { state: "ready", frame: 0, meshes: [data] });
  expect(guides.hidden).toBe(false);
  expect(guides.style.getPropertyValue("--crosshair-x")).toBe("200px");
  expect(guides.style.getPropertyValue("--crosshair-y")).toBe("150px");
  const object = objects()[0].children[0] as Mesh;
  const geometry = object.geometry,
    camera = state.camera!;
  view.setCrosshair(volume, [2, 4, 5], true);
  const verifyPosition = () => {
    // World coordinate computed independently from the fixture affine.
    const point = new Vector3(94.5, -44, 40).project(camera);
    expect(guides.hidden).toBe(false);
    expect(guides.style.getPropertyValue("--crosshair-x")).toBe(
      `${Math.round((point.x + 1) * 200)}px`,
    );
    expect(guides.style.getPropertyValue("--crosshair-y")).toBe(
      `${Math.round((1 - point.y) * 150)}px`,
    );
  };
  verifyPosition();
  const before = camera.position.clone();
  viewport
    .querySelector("canvas")!
    .dispatchEvent(new WheelEvent("wheel", { deltaY: -100, cancelable: true }));
  expect(camera.position.equals(before)).toBe(false);
  verifyPosition();
  view.setCrosshair(volume, [2, 4, 5], false);
  expect(guides.hidden).toBe(true);
  view.setCrosshair(volume, [2, 4, 5], true);
  expect(guides.hidden).toBe(false);
  expect(object.geometry).toBe(geometry);
  expect(object.visible).toBe(true);
  view.setCrosshair(volume, [100000, 4, 5], true);
  expect(guides.hidden).toBe(true);
});
