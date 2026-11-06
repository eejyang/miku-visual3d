import type {
  Axis,
  HostMessage,
  SlicePixels,
  SliceRequest,
  VolumeInfo,
  SourceKind,
  OverlayLayer,
} from "../protocol";
import {
  SLICE_AXES,
  describePlanes,
  displayDirections,
  voxelToScreen,
  screenToVoxel,
  type PlaneDisplay,
  type PlaneDescription,
} from "./orientation";
import { SurfaceView } from "./surface";
import { colormapTable } from "./colormaps";
import { labelRgb } from "./labelColors";
import { CT_WINDOW_PRESETS, populateWindowPresets } from "./windowPresets";

declare function acquireVsCodeApi(): { postMessage(value: unknown): void };
const api = acquireVsCodeApi();
const surface = new SurfaceView(
  document.getElementById("renderViewport")!,
  (message) => api.postMessage(message),
  () => drawAll(),
  (layerId, voxel) => {
    if (!volume || !voxel.every(Number.isFinite)) return;
    indices = voxel.map((n, axis) =>
      Math.max(0, Math.min(volume!.dimensions[axis] - 1, Math.round(n))),
    );
    if (activeMaskId !== layerId)
      api.postMessage({ type: "selectOverlay", layerId });
    else requestAll();
    drawAll();
  },
);
let hasSurfaces = false;
let referenceKind: SourceKind = "image";
let backgroundId: string | undefined = "reference";
let layers: OverlayLayer[] = [];
let sourceKind: SourceKind = "image";
const $ = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const status = $("status");
let activeMaskId: string | undefined;
let showCrosshair = true;
function report(error: unknown) {
  const text = error instanceof Error ? error.message : String(error);
  status.textContent = text;
  status.classList.add("error");
  $("startup").textContent = `Unable to display image: ${text}`;
  api.postMessage({ type: "clientError", message: text });
}
window.addEventListener("error", (e) => report(e.error || e.message));
window.addEventListener("unhandledrejection", (e) => report(e.reason));

interface Plane {
  axis: Axis;
  display: PlaneDisplay;
  canvas: HTMLCanvasElement;
  viewport: HTMLElement;
  crosshair: HTMLElement;
  slider: HTMLInputElement;
  count: HTMLElement;
  context: CanvasRenderingContext2D;
  wanted?: SliceRequest;
  inFlight: boolean;
  activeId?: number;
  current?: { request: SliceRequest; base: SlicePixels; overlay?: SlicePixels };
  base: Float32Array;
  overlay: Float32Array;
  acknowledged?: number;
}
const planes: Plane[] = [];
let volume: VolumeInfo | undefined;
let indices = [0, 0, 0];
let serial = 0;
let windowInitialized = false;
const level = $<HTMLInputElement>("level"),
  windowWidth = $<HTMLInputElement>("window");
const windowPreset = $<HTMLSelectElement>("windowPreset");
const viewLayout = $<HTMLSelectElement>("viewLayout");
const frame = $<HTMLInputElement>("frame");
const colormap = $<HTMLSelectElement>("colormap");
const mainImage = $<HTMLSelectElement>("mainImage");

function formatWindowValue(value: number): string {
  return String(Number(value.toPrecision(6)));
}

function updateHeader() {
  if (!volume) return;
  const images = [
    ...(referenceKind === "image" ? [{ id: "reference", volume }] : []),
    ...layers.filter((layer) => layer.kind === "image" && !layer.isReference),
  ];
  const current = images.find((image) => image.id === backgroundId)?.volume;
  $("title").textContent = current?.name ?? "No image loaded";
  $("title").title = current?.name ?? "No image loaded";
  $("title").hidden = images.length > 1;
  mainImage.hidden = images.length < 2;
  mainImage.replaceChildren(
    ...images.map((image) => {
      const option = document.createElement("option");
      option.value = image.id;
      option.textContent = image.volume.name;
      return option;
    }),
  );
  mainImage.value = backgroundId ?? "";
  mainImage.title = current?.name ?? "选择主影像";
  // The protocol supplies geometry, but no datatype or whole-volume intensity
  // range. Never present current-slice extrema as whole-image metadata.
  const fields: string[] = [];
  if (current) {
    fields.push(current.dimensions.join(" × "));
    const unit = ({ 1: "m", 2: "mm", 3: "µm" } as Record<number, string>)[
      current.spatialUnits & 7
    ];
    if (current.spacing.every((n) => Number.isFinite(n) && n > 0))
      fields.push(
        `${current.spacing.map((n) => Number(n.toPrecision(6))).join(" × ")} ${unit ?? "mm"}`,
      );
    if (current.frames > 1) fields.push(`${current.frames} frames`);
  }
  $("details").textContent = fields.join(" · ");
  $("details").title = fields.join(" · ");
}

function decode(plane: SlicePixels): Float32Array {
  const bytes = Uint8Array.from(atob(plane.pixels), (c) => c.charCodeAt(0));
  if (bytes.length !== plane.width * plane.height * 4)
    throw new Error("Invalid slice data length.");
  const view = new DataView(bytes.buffer);
  return Float32Array.from({ length: plane.width * plane.height }, (_, i) =>
    view.getFloat32(i * 4, true),
  );
}
function setSourceKind(kind: SourceKind) {
  const changed = sourceKind !== kind;
  sourceKind = kind;
  for (const id of [
    "windowPresetLabel",
    "levelLabel",
    "windowLabel",
    "colormapLabel",
  ])
    $(id).hidden = kind === "mask";
  if (changed) {
    windowInitialized = false;
    windowPreset.value = "auto";
  }
  drawAll();
}
function fit(plane: Plane) {
  if (!volume) return;
  const { u, v } = plane.display;
  const ratio =
    (volume.dimensions[u] * volume.spacing[u]) /
    (volume.dimensions[v] * volume.spacing[v]);
  const w = Math.max(1, plane.viewport.clientWidth - 48),
    h = Math.max(1, plane.viewport.clientHeight - 48);
  const width = Math.min(w, h * ratio);
  const height = width / ratio;
  plane.canvas.style.width = `${width}px`;
  plane.canvas.style.height = `${height}px`;
  // Locate the voxel center within the fitted image, then extend the guides
  // across the viewport in CSS pixels, independently of the image resolution.
  const [screenX, screenY] = voxelToScreen(
    plane.display,
    volume.dimensions,
    indices,
  );
  const x = (plane.viewport.clientWidth - width) / 2 + screenX * width;
  const y = (plane.viewport.clientHeight - height) / 2 + screenY * height;
  plane.crosshair.style.setProperty("--crosshair-x", `${Math.round(x)}px`);
  plane.crosshair.style.setProperty("--crosshair-y", `${Math.round(y)}px`);
  plane.crosshair.hidden = !showCrosshair || !plane.current;
}
function draw(plane: Plane) {
  if (!plane.current || !volume) return;
  const { base } = plane.current;
  const { display } = plane;
  const transpose = display.u !== SLICE_AXES[plane.axis][0];
  const pixelWidth = transpose ? base.height : base.width;
  const pixelHeight = transpose ? base.width : base.height;
  plane.canvas.width = pixelWidth;
  plane.canvas.height = pixelHeight;
  const image = plane.context.createImageData(pixelWidth, pixelHeight);
  const width = Math.max(1e-5, Number(windowWidth.value) || 1);
  const low = (Number(level.value) || 0) - width / 2;
  const style = surface.displayStyle(activeMaskId);
  const alpha =
    style?.visible === false
      ? 0
      : (style?.opacity ?? (sourceKind === "mask" ? 1 : 0.65));
  const custom =
    style?.colorMode === "custom"
      ? [1, 3, 5].map((start) =>
          parseInt(style.color.slice(start, start + 2), 16),
        )
      : undefined;
  const table = colormapTable(colormap.value);
  let visiblePixels = 0;
  for (let y = 0; y < base.height; y++)
    for (let x = 0; x < base.width; x++) {
      const source = y * base.width + x;
      let screenX = transpose ? y : x;
      let screenY = transpose ? x : y;
      if (display.flipU) screenX = pixelWidth - 1 - screenX;
      if (display.flipV) screenY = pixelHeight - 1 - screenY;
      const p = ((pixelHeight - screenY - 1) * pixelWidth + screenX) * 4;
      const value = plane.base[source],
        o = plane.overlay[source];
      const gray =
        sourceKind !== "mask" && Number.isFinite(value)
          ? Math.max(0, Math.min(255, ((value - low) * 255) / width))
          : 0;
      const a =
        Number.isFinite(o) && o !== 0 && !style?.hiddenLabels.has(o)
          ? alpha
          : 0;
      const color = a ? (custom ?? labelRgb(o)) : undefined;
      const offset = Math.round(gray) * 3;
      for (let channel = 0; channel < 3; channel++) {
        const background =
          sourceKind === "mask" ? 0 : table ? table[offset + channel] : gray;
        image.data[p + channel] =
          background * (1 - a) + (color ? color[channel] : 0) * a;
      }
      image.data[p + 3] = 255;
      if (image.data[p] || image.data[p + 1] || image.data[p + 2])
        visiblePixels++;
    }
  plane.context.putImageData(image, 0, 0);
  // Acknowledged only after a real Canvas2D write. Tests also verify that the
  // renderer readback contains nonblack pixels for the supplied MRI fixture.
  if (plane.acknowledged !== plane.current.request.id) {
    const readback = plane.context.getImageData(
      0,
      0,
      pixelWidth,
      pixelHeight,
    ).data;
    let nonblack = 0;
    for (let p = 0; p < readback.length; p += 4)
      if (readback[p] || readback[p + 1] || readback[p + 2]) nonblack++;
    if (visiblePixels !== nonblack)
      throw new Error("Canvas pixel verification failed.");
    api.postMessage({
      type: "painted",
      id: plane.current.request.id,
      axis: plane.axis,
      width: pixelWidth,
      height: pixelHeight,
      visiblePixels: nonblack,
    });
    plane.acknowledged = plane.current.request.id;
  }
  fit(plane);
}
function drawAll() {
  planes.forEach(draw);
}
function applyLayout() {
  const mode = viewLayout.value;
  const panels = $("panels");
  panels.dataset.layout =
    mode === "quad" || mode === "slices" ? mode : "single";
  panels.setAttribute(
    "aria-label",
    `${viewLayout.selectedOptions[0].textContent}影像视图`,
  );
  for (const section of panels.querySelectorAll<HTMLElement>(".plane")) {
    section.hidden =
      mode === "slices"
        ? section.dataset.view === "render"
        : mode !== "quad" && section.dataset.view !== mode;
  }
  // Keep existing canvases, slices and the 3D camera; only fit the visible panes.
  requestAnimationFrame(() => planes.forEach(fit));
}
function send(plane: Plane) {
  if (!plane.inFlight && plane.wanted) {
    plane.inFlight = true;
    plane.activeId = plane.wanted.id;
    api.postMessage({ type: "slice", request: plane.wanted });
  }
}
function request(plane: Plane) {
  if (!volume) return;
  plane.slider.value = String(indices[plane.axis]);
  plane.count.textContent = `${indices[plane.axis] + 1} / ${volume.dimensions[plane.axis]}`;
  plane.wanted = {
    id: ++serial,
    axis: plane.axis,
    index: indices[plane.axis],
    frame: Number(frame.value),
  };
  status.textContent = "Loading slices…";
  status.classList.remove("error");
  send(plane);
}
function requestAll() {
  planes.forEach(request);
}
function autoWindow() {
  windowPreset.value = "auto";
  windowInitialized = false;
  const slices = planes
    .map((p) => p.current?.base)
    .filter((p): p is SlicePixels => !!p);
  if (!slices.length) return;
  const min = Math.min(...slices.map((p) => p.min)),
    max = Math.max(...slices.map((p) => p.max));
  level.value = formatWindowValue((min + max) / 2);
  windowWidth.value = formatWindowValue(Math.max(max - min, 1e-5));
  windowInitialized = max > min;
  drawAll();
}
function createPlane(description: PlaneDescription): Plane {
  const { axis, view, title, english, note, display } = description;
  const option = viewLayout.querySelector<HTMLOptionElement>(
    `option[value="${view}"]`,
  )!;
  option.textContent = note ? `${title} · ${note}` : title;
  const section = document.createElement("section");
  section.className = "plane";
  section.dataset.axis = String(axis);
  section.dataset.view = view;
  section.innerHTML = `<div class="plane-title"><div class="plane-heading"><h2>${title}</h2><span class="plane-english">${english}</span><span class="plane-note" ${note ? "" : "hidden"}>${note}</span></div><span class="count"></span></div><div class="viewport"><canvas aria-label="${title}影像"></canvas><div class="crosshair" hidden aria-hidden="true"><span class="crosshair-horizontal"></span><span class="crosshair-vertical"></span></div><span class="top"></span><span class="bottom"></span><span class="left"></span><span class="right"></span></div><input class="slice" type="range" min="0" value="0" aria-label="${title}切片">`;
  $("panels").append(section);
  const canvas = section.querySelector("canvas")!;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Unable to create a Canvas2D context.");
  const plane: Plane = {
    axis,
    display,
    canvas,
    context,
    viewport: section.querySelector(".viewport")!,
    crosshair: section.querySelector(".crosshair")!,
    slider: section.querySelector(".slice")!,
    count: section.querySelector(".count")!,
    inFlight: false,
    base: new Float32Array(0),
    overlay: new Float32Array(0),
  };
  plane.slider.max = String(volume!.dimensions[axis] - 1);
  const { u, v } = display;
  for (const [side, label] of Object.entries(
    displayDirections(volume!, display),
  ))
    section.querySelector(`.${side}`)!.textContent = label;
  plane.slider.oninput = () => {
    indices[axis] = Number(plane.slider.value);
    request(plane);
    drawAll();
  };
  plane.viewport.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      indices[axis] = Math.max(
        0,
        Math.min(
          volume!.dimensions[axis] - 1,
          indices[axis] + (event.deltaY > 0 ? 1 : -1),
        ),
      );
      request(plane);
      drawAll();
    },
    { passive: false },
  );
  let drag: { x: number; y: number; level: number; width: number } | undefined;
  canvas.oncontextmenu = (e) => e.preventDefault();
  canvas.onpointerdown = (e) => {
    if (e.button === 2) {
      drag = {
        x: e.clientX,
        y: e.clientY,
        level: Number(level.value),
        width: Number(windowWidth.value),
      };
      canvas.setPointerCapture(e.pointerId);
    } else if (e.button === 0) {
      const rect = canvas.getBoundingClientRect();
      [indices[u], indices[v]] = screenToVoxel(
        display,
        volume!.dimensions,
        (e.clientX - rect.left) / rect.width,
        (e.clientY - rect.top) / rect.height,
      );
      planes.filter((p) => p.axis !== axis).forEach(request);
      drawAll();
    }
  };
  canvas.onpointermove = (e) => {
    if (!drag) return;
    const scale = Math.max(1, drag.width) / 200;
    level.value = formatWindowValue(drag.level + (e.clientY - drag.y) * scale);
    windowWidth.value = formatWindowValue(
      Math.max(1e-5, drag.width + (e.clientX - drag.x) * scale),
    );
    windowInitialized = true;
    windowPreset.value = "custom";
    drawAll();
  };
  canvas.onpointerup = canvas.onpointercancel = () => {
    drag = undefined;
  };
  new ResizeObserver(() => fit(plane)).observe(plane.viewport);
  return plane;
}

try {
  $("loadImage").onclick = () => api.postMessage({ type: "openImage" });
  $("addImage").onclick = () => api.postMessage({ type: "overlay" });
  viewLayout.onchange = applyLayout;
  mainImage.onchange = () =>
    api.postMessage({ type: "selectOverlay", layerId: mainImage.value });
  colormap.onchange = drawAll;
  $("toggleCrosshair").onclick = () => {
    showCrosshair = !showCrosshair;
    $("toggleCrosshair").setAttribute("aria-pressed", String(showCrosshair));
    planes.forEach(fit);
  };
  $("resetDisplay").onclick = () => {
    autoWindow();
    planes.forEach(fit);
  };
  populateWindowPresets(windowPreset);
  windowPreset.onchange = () => {
    if (windowPreset.value === "auto") {
      autoWindow();
      return;
    }
    if (windowPreset.value === "custom") {
      windowInitialized = true;
      return;
    }
    const preset = CT_WINDOW_PRESETS.find((p) => p.id === windowPreset.value);
    if (!preset) return;
    level.value = formatWindowValue(preset.level);
    windowWidth.value = formatWindowValue(preset.width);
    windowInitialized = true;
    drawAll();
  };
  level.oninput = windowWidth.oninput = () => {
    windowInitialized = true;
    windowPreset.value = "custom";
    drawAll();
  };
  level.onchange = windowWidth.onchange = (event) => {
    const input = event.currentTarget as HTMLInputElement;
    if (!Number.isFinite(input.valueAsNumber)) return;
    input.value = formatWindowValue(input.valueAsNumber);
    drawAll();
  };
  frame.oninput = () => {
    $("frameValue").textContent =
      `${Number(frame.value) + 1} / ${volume!.frames}`;
    requestAll();
    if (hasSurfaces)
      api.postMessage({ type: "surface", frame: Number(frame.value) });
  };
  window.addEventListener("message", (event: MessageEvent<HostMessage>) => {
    try {
      const message = event.data;
      if (!message || typeof message !== "object") return;
      switch (message.type) {
        case "volume":
          if (volume) return;
          volume = message.volume;
          referenceKind = message.sourceKind ?? "image";
          setSourceKind(referenceKind);
          updateHeader();
          clearInterval(heartbeat);
          for (const id of [
            "addImage",
            "viewLayout",
            "toggleCrosshair",
            "colormap",
            "windowPreset",
            "level",
            "window",
            "resetDisplay",
          ])
            $<HTMLInputElement>(id).disabled = false;
          $("panels").hidden = false;
          $("startup").hidden = true;
          indices = volume.dimensions.map((n) => Math.floor(n / 2));
          frame.max = String(volume.frames - 1);
          $("frameLabel").hidden = volume.frames === 1;
          $("frameValue").textContent = `1 / ${volume.frames}`;
          for (const description of describePlanes(volume))
            planes.push(createPlane(description));
          applyLayout();
          requestAll();
          break;
        case "slice": {
          const plane = planes.find((p) => p.axis === message.request.axis);
          if (!plane) return;
          if (plane.activeId !== message.request.id) return;
          plane.inFlight = false;
          plane.activeId = undefined;
          if (plane.wanted?.id === message.request.id) {
            plane.current = message;
            plane.base = decode(message.base);
            plane.overlay = message.overlay
              ? decode(message.overlay)
              : new Float32Array(0);
            plane.wanted = undefined;
            if (!windowInitialized) autoWindow();
            else draw(plane);
          }
          send(plane);
          if (planes.every((p) => !p.wanted && p.current))
            status.textContent = "Ready";
          break;
        }
        case "overlay":
          layers = message.layers;
          if (
            message.backgroundId !== backgroundId &&
            windowPreset.value === "auto"
          )
            windowInitialized = false;
          backgroundId =
            message.backgroundId ??
            (referenceKind === "image" ? "reference" : undefined);
          activeMaskId = message.activeId;
          hasSurfaces = layers.some((layer) => layer.kind !== "image");
          surface.setLayers(layers.filter((layer) => layer.kind !== "image"));
          surface.setActiveLayer(message.activeId);
          updateHeader();
          setSourceKind(message.backgroundKind ?? referenceKind);
          if (hasSurfaces)
            api.postMessage({ type: "surface", frame: Number(frame.value) });
          for (const plane of planes) {
            plane.inFlight = false;
            plane.activeId = undefined;
            plane.overlay = new Float32Array(0);
            plane.current = undefined;
          }
          requestAll();
          break;
        case "surface":
          surface.update(message.layerId, message.revision, message.surface);
          break;
        case "status":
          status.textContent = message.message;
          break;
        case "error":
          status.textContent = message.message;
          status.classList.add("error");
          if (!volume) {
            $("startup").textContent = message.message;
            clearInterval(heartbeat);
          }
          if (message.id !== undefined) {
            const plane = planes.find((p) => p.activeId === message.id);
            if (plane) {
              plane.inFlight = false;
              plane.activeId = undefined;
              if (plane.wanted?.id === message.id) plane.wanted = undefined;
              send(plane);
            }
          }
          break;
      }
    } catch (error) {
      report(error);
    }
  });
  const heartbeat = setInterval(() => {
    if (!volume) api.postMessage({ type: "ready" });
  }, 1000);
  api.postMessage({ type: "ready" });
} catch (error) {
  report(error);
}
