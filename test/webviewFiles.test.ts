import { afterEach, beforeAll, expect, it } from "vitest";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Window } from "happy-dom";
import type { HostMessage, VolumeInfo } from "../src/protocol";
import { icon } from "../src/webview/icons";
let script: string, html: string;
const windows: Window[] = [];
beforeAll(async () => {
  script = (
    await build({
      entryPoints: ["src/webview/main.ts"],
      bundle: true,
      write: false,
      platform: "browser",
      format: "iife",
      plugins: [
        {
          name: "test-webgl",
          setup(builder) {
            builder.onResolve({ filter: /^three$/ }, () => ({
              path: "three",
              namespace: "test-webgl",
            }));
            builder.onLoad({ filter: /.*/, namespace: "test-webgl" }, () => ({
              loader: "js",
              resolveDir: process.cwd(),
              contents: `
          export * from ${JSON.stringify(resolve("node_modules/three/build/three.module.js"))};
          export class WebGLRenderer {
            domElement=document.createElement("canvas");
            setPixelRatio(){} setSize(){} setRenderTarget(){} dispose(){} render(){}
            readRenderTargetPixels(_target,_x,_y,_width,_height,pixels){pixels.fill(255);}
          }
        `,
            }));
          },
        },
      ],
    })
  ).outputFiles[0].text;
  html = (await readFile("src/extension.ts", "utf8"))
    .split("panel.webview.html = `")[1]
    .split("`;")[0]
    .replace(/<script[\s\S]*?<\/script>/g, "")
    .replace(/\$\{icon\("([a-z-]+)"\)\}/g, (_, name) =>
      icon(name as Parameters<typeof icon>[0]),
    );
});
afterEach(async () => {
  await Promise.all(windows.splice(0).map((window) => window.happyDOM.close()));
});
function launch() {
  const window = new Window({
    settings: {
      disableCSSFileLoading: true,
      disableJavaScriptFileLoading: true,
    },
  });
  windows.push(window);
  const sent: any[] = [];
  (window as any).acquireVsCodeApi = () => ({
    postMessage: (m: unknown) => sent.push(m),
  });
  window.ResizeObserver = class {
    observe() {}
    disconnect() {}
    unobserve() {}
  };
  const contexts = new Map<any, any>();
  (window.HTMLCanvasElement.prototype as any).getContext = function () {
    if (!contexts.has(this))
      contexts.set(this, {
        data: new Uint8ClampedArray(),
        createImageData: (w: number, h: number) => ({
          data: new Uint8ClampedArray(w * h * 4),
        }),
        putImageData(image: any) {
          this.data = image.data.slice();
        },
        getImageData() {
          return { data: this.data.slice() };
        },
      });
    return contexts.get(this);
  };
  window.document.write(html);
  window.eval(script);
  const post = (data: HostMessage) =>
    window.dispatchEvent(new window.MessageEvent("message", { data }));
  const pixels = (values: number[]) => {
    const bytes = Buffer.alloc(values.length * 4);
    values.forEach((v, i) => bytes.writeFloatLE(v, i * 4));
    return {
      width: 2,
      height: 2,
      pixels: bytes.toString("base64"),
      min: 0,
      max: 100,
    };
  };
  const paint = () => {
    for (const { request } of sent.filter((m) => m.type === "slice").slice(-3))
      post({
        type: "slice",
        request,
        base: pixels([50, 50, 50, 50]),
        overlay: pixels([0, 1, 2, 1]),
      });
  };
  return { window, doc: window.document, sent, post, paint, contexts };
}
const reference: VolumeInfo = {
  name: "CT.nii.gz",
  dimensions: [2, 2, 2],
  spacing: [1, 1, 1],
  frames: 1,
  affine: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0],
  hasOrientation: true,
  spatialUnits: 2,
};
it("keeps one loader, a main-image header and independent Mask modules", () => {
  const { doc, sent, post, paint, contexts } = launch();
  expect(doc.getElementById("addOverlay")).toBeNull();
  expect(doc.getElementById("activeOverlay")).toBeNull();
  doc.getElementById("loadImage")!.click();
  expect(sent.at(-1)).toEqual({ type: "openImage" });
  post({ type: "volume", volume: reference, sourceKind: "image" });
  paint();
  const layers = [
    {
      id: "mask-1",
      kind: "mask" as const,
      volume: { ...reference, name: "GT.nii.gz" },
    },
    {
      id: "mask-2",
      kind: "mask" as const,
      volume: { ...reference, name: "Prediction.nii.gz" },
    },
  ];
  post({
    type: "overlay",
    volume: layers[1].volume,
    layers,
    activeId: "mask-2",
    backgroundKind: "image",
  });
  paint();
  expect(doc.getElementById("fileTabs")).toBeNull();
  expect(doc.getElementById("opacity")).toBeNull();
  expect(doc.getElementById("rebuildSurface")).toBeNull();
  expect(doc.getElementById("renderLegend")).toBeNull();
  expect(doc.getElementById("title")!.textContent).toBe("CT.nii.gz");
  expect(doc.getElementById("details")!.textContent).toBe(
    "2 × 2 × 2 · 1 × 1 × 1 mm",
  );
  expect(
    [...doc.querySelectorAll("details.surface-layer .surface-filename")].map(
      (n) => n.textContent,
    ),
  ).toEqual(["GT.nii.gz", "Prediction.nii.gz"]);
  expect(
    doc
      .querySelector<any>('[data-layer-id="mask-2"] .surface-active')!
      .getAttribute("aria-pressed"),
  ).toBe("true");
  const canvas = doc.querySelector("[data-axis] canvas")!;
  const opacity = doc.querySelector<any>(
    '[data-layer-id="mask-2"] .surface-opacity',
  )!;
  opacity.value = "0.5";
  opacity.dispatchEvent(new doc.defaultView!.Event("input"));
  expect([...contexts.get(canvas).data.slice(8, 11)]).toEqual([128, 128, 128]);
  expect([...contexts.get(canvas).data.slice(12, 15)]).toEqual([104, 158, 180]);
  doc.querySelector<any>('[data-layer-id="mask-1"] .surface-active')!.click();
  expect(sent.at(-1)).toEqual({ type: "selectOverlay", layerId: "mask-1" });
  doc.querySelector<any>('[data-layer-id="mask-2"] .surface-remove')!.click();
  expect(sent.at(-1)).toEqual({ type: "removeOverlay", layerId: "mask-2" });
  expect(sent.filter((m) => m.type === "clientError")).toEqual([]);
});

it("switches layouts and crosshair visibility without changing slices or issuing data requests", () => {
  const { window, doc, sent, post, paint } = launch();
  post({ type: "volume", volume: reference, sourceKind: "image" });
  paint();
  const positions = [...doc.querySelectorAll<any>(".slice")].map(
    (n) => n.value,
  );
  const before = sent.length;
  const crosshair = doc.getElementById("toggleCrosshair")!;
  crosshair.click();
  expect(crosshair.getAttribute("aria-pressed")).toBe("false");
  expect(
    [...doc.querySelectorAll<any>(".crosshair")].every((n) => n.hidden),
  ).toBe(true);
  const layout = doc.getElementById("viewLayout") as any;
  for (const mode of [
    "axial",
    "sagittal",
    "coronal",
    "render",
    "slices",
    "quad",
  ]) {
    layout.value = mode;
    layout.dispatchEvent(new window.Event("change"));
    const visible = [...doc.querySelectorAll<any>(".plane")].filter(
      (n) => !n.hidden,
    );
    expect(visible.length).toBe(
      mode === "quad" ? 4 : mode === "slices" ? 3 : 1,
    );
  }
  crosshair.click();
  expect(
    [...doc.querySelectorAll<any>(".crosshair")].every((n) => !n.hidden),
  ).toBe(true);
  expect([...doc.querySelectorAll<any>(".slice")].map((n) => n.value)).toEqual(
    positions,
  );
  expect(sent.length).toBe(before);
});

it("maps only main-image colors and shares Mask visibility, opacity and custom color controls", () => {
  const { window, doc, sent, post, paint, contexts } = launch();
  post({ type: "volume", volume: reference, sourceKind: "image" });
  post({
    type: "overlay",
    volume: reference,
    layers: [{ id: "mask", kind: "mask", volume: reference }],
    activeId: "mask",
    backgroundId: "reference",
    backgroundKind: "image",
  });
  paint();
  const canvas = doc.querySelector("[data-axis] canvas")!;
  const pixel = (offset: number) => [
    ...contexts.get(canvas).data.slice(offset, offset + 3),
  ];
  const input = (
    selector: string,
    value: string | boolean,
    event = "input",
  ) => {
    const element = doc.querySelector<any>(selector)!;
    if (typeof value === "boolean") {
      if ((element.getAttribute("aria-pressed") === "true") !== value)
        element.click();
      return;
    }
    element.value = value;
    element.dispatchEvent(new window.Event(event));
  };
  input(".surface-opacity", "1");
  const mask = pixel(12);
  const gray = pixel(8);
  const requests = sent.length;
  for (const name of ["viridis", "magma", "hot"]) {
    input("#colormap", name, "change");
    expect(pixel(8)).not.toEqual(gray);
    expect(pixel(12)).toEqual(mask);
  }
  input(".surface-color", "#ff0000");
  expect(pixel(12)).toEqual([255, 0, 0]);
  input(".surface-opacity", "0");
  expect(pixel(12)).toEqual(pixel(8));
  input(".surface-opacity", "1");
  input(".surface-visible", false, "change");
  expect(pixel(12)).toEqual(pixel(8));
  input(".surface-visible", true, "change");
  expect(pixel(12)).toEqual([255, 0, 0]);
  expect(sent.length).toBe(requests);
});

it("synchronizes presets and manual WL/WW, then resets cached display without clearing data", () => {
  const { window, doc, sent, post, paint, contexts } = launch();
  post({ type: "volume", volume: reference, sourceKind: "image" });
  post({
    type: "overlay",
    volume: reference,
    layers: [{ id: "mask", kind: "mask", volume: reference }],
    activeId: "mask",
    backgroundId: "reference",
    backgroundKind: "image",
  });
  paint();
  const maskRow = doc.querySelector<any>(".surface-layer")!;
  maskRow.open = false;
  const preset = doc.getElementById("windowPreset") as any;
  const level = doc.getElementById("level") as any;
  const width = doc.getElementById("window") as any;
  const canvas = doc.querySelector("[data-axis] canvas")!;
  const initial = [...contexts.get(canvas).data];
  const requests = sent.length;
  preset.value = "lung";
  preset.dispatchEvent(new window.Event("change"));
  expect([level.value, width.value]).toEqual(["-600", "1500"]);
  level.value = "0";
  width.value = "10";
  level.dispatchEvent(new window.Event("input"));
  expect(preset.value).toBe("custom");
  expect([...contexts.get(canvas).data]).not.toEqual(initial);
  doc.getElementById("resetDisplay")!.click();
  expect(preset.value).toBe("auto");
  expect([level.value, width.value]).toEqual(["50", "100"]);
  expect([...contexts.get(canvas).data]).toEqual(initial);
  expect(sent.length).toBe(requests);
  expect(doc.querySelectorAll(".plane")).toHaveLength(4);
  expect(doc.querySelector(".surface-layer")).toBe(maskRow);
  expect(maskRow.open).toBe(false);
});

it("uses only reliable metadata, omits unknown spacing units and hides Mask names from the header", () => {
  const { doc, post } = launch();
  post({
    type: "volume",
    volume: { ...reference, frames: 4, spatialUnits: 0 },
    sourceKind: "image",
  });
  expect(doc.getElementById("details")!.textContent).toBe("2 × 2 × 2 · 4 帧");
  const second = {
    id: "image-2",
    kind: "image" as const,
    volume: { ...reference, name: "MRI.nii.gz" },
  };
  post({
    type: "overlay",
    volume: null,
    layers: [second],
    backgroundId: second.id,
    backgroundKind: "image",
    activeId: second.id,
  });
  expect(doc.getElementById("title")!.hidden).toBe(true);
  expect(doc.querySelector<any>("#mainImage")!.value).toBe(second.id);
  expect(
    [...doc.querySelectorAll("#mainImage option")].map((n) => n.textContent),
  ).toEqual(["CT.nii.gz", "MRI.nii.gz"]);
  const standalone = launch();
  standalone.post({
    type: "volume",
    volume: { ...reference, name: "Mask.nii.gz" },
    sourceKind: "mask",
  });
  expect(standalone.doc.querySelector("header")!.textContent).not.toContain(
    "Mask.nii.gz",
  );
  expect(standalone.doc.getElementById("details")!.textContent).toBe("");
});

it("jumps all linked slices to the selected Mask label without changing its visibility", () => {
  const { doc, post, paint, sent } = launch();
  const affine = [0, -2, 0.5, 100, 3, 0, 0, -50, 0, 0, 4, 20];
  const info = { ...reference, dimensions: [10, 10, 10], affine };
  post({ type: "volume", volume: info, sourceKind: "image" });
  post({
    type: "overlay",
    volume: info,
    layers: [{ id: "mask", kind: "mask", volume: info }],
    activeId: "mask",
    backgroundId: "reference",
    backgroundKind: "image",
  });
  paint();
  const vertices = Buffer.alloc(36),
    indices = Buffer.alloc(12);
  [97.5, -47, 32, 97.5, -35, 32, 91.5, -47, 48].forEach((n, i) =>
    vertices.writeFloatLE(n, i * 4),
  );
  [0, 1, 2].forEach((n, i) => indices.writeUInt32LE(n, i * 4));
  post({
    type: "surface",
    layerId: "mask",
    revision: 1,
    surface: {
      state: "ready",
      frame: 0,
      meshes: [
        {
          label: 7,
          vertices: vertices.toString("base64"),
          indices: indices.toString("base64"),
        },
      ],
    },
  });
  const locate = doc.querySelector<any>(".surface-locate")!;
  expect(locate.disabled).toBe(true);
  doc.querySelector<any>(".surface-label-select")!.click();
  expect(locate.disabled).toBe(false);
  doc.querySelector<any>(".surface-visible")!.click();
  locate.click();
  expect(
    sent
      .filter((m) => m.type === "slice")
      .slice(-3)
      .map((m) => [m.request.axis, m.request.index])
      .sort(),
  ).toEqual([
    [0, 3],
    [1, 4],
    [2, 5],
  ]);
  expect(
    doc.querySelector(".surface-visible")!.getAttribute("aria-pressed"),
  ).toBe("false");
  expect(
    sent.filter(
      (m) => m.type === "clientError" || m.type === "surfaceClientError",
    ),
  ).toEqual([]);
});
