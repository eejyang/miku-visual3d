import {
  AmbientLight,
  Box3,
  BufferAttribute,
  BufferGeometry,
  Color,
  DirectionalLight,
  DoubleSide,
  Group,
  Mesh,
  Matrix4,
  MeshPhongMaterial,
  PerspectiveCamera,
  Scene,
  Vector3,
  WebGLRenderer,
  WebGLRenderTarget,
} from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type {
  OverlayLayer,
  SurfaceMesh,
  SurfaceUpdate,
  VolumeInfo,
} from "../protocol";
import { labelColor } from "./labelColors";
import { icon } from "./icons";

type SurfaceObject = Mesh<BufferGeometry, MeshPhongMaterial>;
const MASK_COLORS = [
  { name: "Red", color: "#ef4444" },
  { name: "Orange", color: "#f97316" },
  { name: "Yellow", color: "#facc15" },
  { name: "Green", color: "#22c55e" },
  { name: "Cyan", color: "#06b6d4" },
  { name: "Blue", color: "#3b82f6" },
  { name: "Purple", color: "#a855f7" },
  { name: "Pink", color: "#ec4899" },
] as const;
interface LayerView {
  info: OverlayLayer;
  group: Group;
  row: HTMLElement;
  status: HTMLElement;
  labels: HTMLElement;
  visible: boolean;
  color: string;
  colorMode: "auto" | "custom";
  opacity: number;
  wireframe: boolean;
  hiddenLabels: Set<number>;
  selectedLabel?: number;
  revision: number;
  state: SurfaceUpdate["state"];
}
function decode(
  encoded: string,
  floating: boolean,
): Float32Array | Uint32Array {
  const bytes = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
  if (bytes.length % 4) throw new Error("Invalid 3D mesh data length.");
  const view = new DataView(bytes.buffer);
  const result = floating
    ? new Float32Array(bytes.length / 4)
    : new Uint32Array(bytes.length / 4);
  for (let i = 0; i < result.length; i++)
    result[i] = floating
      ? view.getFloat32(i * 4, true)
      : view.getUint32(i * 4, true);
  return result;
}

/** One persistent scene; each source file owns its meshes and display controls. */
export class SurfaceView {
  private renderer?: WebGLRenderer;
  private scene = new Scene();
  private group = new Group();
  private layers = new Map<string, LayerView>();
  private camera = new PerspectiveCamera(35, 1, 0.01, 10000);
  private controls?: OrbitControls;
  private observer: ResizeObserver;
  private radius = 1;
  private center = new Vector3();
  private hasFramed = false;
  private crosshair = document.createElement("div");
  private crosshairPosition?: Vector3;
  private crosshairEnabled = true;
  private message = document.getElementById("renderMessage")!;
  private list = document.getElementById("surfaceLayers")!;
  private reset = document.getElementById("resetSurface") as HTMLButtonElement;

  constructor(
    private viewport: HTMLElement,
    private post: (value: unknown) => void,
    private displayChanged: () => void = () => {},
    private locate: (layerId: string, voxel: number[]) => void = () => {},
  ) {
    this.scene.background = new Color("#08090b");
    this.scene.add(this.group, new AmbientLight(0xffffff, 1.1));
    const key = new DirectionalLight(0xffffff, 2.5);
    key.position.set(1, -2, 3);
    const fill = new DirectionalLight(0xb7d2ff, 1.3);
    fill.position.set(-2, 1, -1);
    this.scene.add(key, fill);
    this.camera.up.set(0, 0, 1);
    this.crosshair.className = "crosshair";
    this.crosshair.hidden = true;
    this.crosshair.setAttribute("aria-hidden", "true");
    this.crosshair.innerHTML =
      '<span class="crosshair-horizontal"></span><span class="crosshair-vertical"></span>';
    this.viewport.append(this.crosshair);
    this.reset.onclick = () => this.home();
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(viewport);
    window.addEventListener("pagehide", () => this.dispose(), { once: true });
  }

  setLayers(infos: OverlayLayer[]) {
    const ids = new Set(infos.map((info) => info.id));
    for (const [id, layer] of this.layers)
      if (!ids.has(id)) {
        this.clearLayer(layer);
        this.group.remove(layer.group);
        layer.row.remove();
        this.layers.delete(id);
      }
    for (const info of infos) {
      const existing = this.layers.get(info.id);
      if (existing) existing.info = info;
      else {
        this.layers.set(info.id, this.createLayer(info));
      }
    }
    this.list.hidden = !this.layers.size;
    if (!this.layers.size) this.hasFramed = false;
    this.refresh();
  }

  setActiveLayer(id: string | undefined) {
    for (const [key, layer] of this.layers)
      layer.row
        .querySelector<HTMLButtonElement>(".surface-active")!
        .setAttribute("aria-pressed", String(key === id));
  }

  setCrosshair(
    volume: VolumeInfo,
    indices: readonly number[],
    visible: boolean,
  ) {
    const a = volume.affine;
    // Integer voxel indices already refer to voxel centers in NIfTI. Use the
    // reference affine, including scale, rotation, shear and translation.
    this.crosshairPosition = new Vector3(
      a[0] * indices[0] + a[1] * indices[1] + a[2] * indices[2] + a[3],
      a[4] * indices[0] + a[5] * indices[1] + a[6] * indices[2] + a[7],
      a[8] * indices[0] + a[9] * indices[1] + a[10] * indices[2] + a[11],
    );
    this.crosshairEnabled = visible;
    this.updateCrosshair();
  }

  private updateCrosshair() {
    this.crosshair.hidden = true;
    if (
      !this.renderer ||
      !this.hasFramed ||
      this.reset.disabled ||
      !this.crosshairEnabled ||
      !this.crosshairPosition
    )
      return;
    const width = this.viewport.clientWidth,
      height = this.viewport.clientHeight;
    if (!width || !height) return;
    this.camera.updateMatrixWorld();
    const point = this.crosshairPosition.clone().project(this.camera);
    // A cursor outside the camera frustum must not become an edge marker or
    // appear mirrored when the current voxel is behind the camera.
    if (
      !point.toArray().every(Number.isFinite) ||
      Math.abs(point.x) > 1 ||
      Math.abs(point.y) > 1 ||
      Math.abs(point.z) > 1
    )
      return;
    this.crosshair.style.setProperty(
      "--crosshair-x",
      `${Math.round(((point.x + 1) * width) / 2)}px`,
    );
    this.crosshair.style.setProperty(
      "--crosshair-y",
      `${Math.round(((1 - point.y) * height) / 2)}px`,
    );
    this.crosshair.hidden = false;
  }

  displayStyle(
    id: string | undefined,
  ):
    | Readonly<
        Pick<
          LayerView,
          "visible" | "opacity" | "color" | "colorMode" | "hiddenLabels"
        >
      >
    | undefined {
    return id ? this.layers.get(id) : undefined;
  }

  update(id: string, revision: number, update: SurfaceUpdate) {
    const layer = this.layers.get(id);
    if (!layer || revision < layer.revision) return;
    try {
      if (
        revision !== layer.revision ||
        update.state !== "loading" ||
        layer.state !== "loading"
      )
        this.clearLayer(layer);
      layer.revision = revision;
      layer.state = update.state;
      layer.status.classList.toggle("error", update.state === "error");
      layer.status.hidden = false;
      layer.row.querySelector(".surface-label-count")!.textContent =
        update.state === "ready"
          ? `· ${update.meshes.length} ${update.meshes.length === 1 ? "label" : "labels"}`
          : "";
      if (update.state !== "ready") {
        layer.status.textContent = update.message;
        this.refresh();
        return;
      }
      if (!update.meshes.length) {
        layer.status.textContent = "Current frame contains background only.";
        this.refresh();
        return;
      }
      this.initialize();
      update.meshes.forEach((mesh) => this.add(layer, mesh));
      if (
        !layer.group.children.some(
          (object) => object.userData.label === layer.selectedLabel,
        )
      )
        layer.selectedLabel = undefined;
      this.updateSelection(layer);
      const triangles = this.triangleCount(layer);
      layer.status.hidden = true;
      layer.status.textContent = `${triangles.toLocaleString()} triangles`;
      this.updateBounds();
      if (!this.hasFramed) {
        this.home();
        this.hasFramed = true;
      }
      this.refresh();
      this.verifyPaint(layer, triangles);
    } catch (error) {
      this.clearLayer(layer);
      layer.state = "error";
      layer.status.classList.add("error");
      layer.status.hidden = false;
      layer.status.textContent = `3D rendering failed: ${error instanceof Error ? error.message : String(error)}`;
      this.post({
        type: "surfaceClientError",
        layerId: id,
        revision,
        message: layer.status.textContent,
      });
      this.refresh();
    }
  }

  private createLayer(info: OverlayLayer): LayerView {
    const row = document.createElement("details");
    row.open = true;
    row.className = "surface-layer";
    row.dataset.layerId = info.id;
    row.innerHTML = `<summary><span class="surface-file-info"><button class="icon-button surface-active" title="在二维查看此 Mask" aria-label="在二维查看此 Mask" aria-pressed="false">${icon("layers")}</button><span class="surface-filename"></span><span class="surface-label-count"></span></span><span class="surface-display-controls"><label class="surface-opacity-control" title="Mask 不透明度">${icon("opacity")} <input class="surface-opacity" aria-label="Mask 不透明度" type="range" min="0" max="1" step="0.05"><output></output></label><button class="icon-button surface-visible" title="隐藏标签" aria-label="隐藏标签" aria-pressed="true">${icon("eye")}</button><span class="surface-modes" role="group" aria-label="表面模式"><button class="icon-button surface-solid" title="实体表面" aria-label="实体表面" aria-pressed="true">${icon("box")}</button><button class="icon-button surface-wireframe" title="线框表面" aria-label="线框表面" aria-pressed="false">${icon("grid-3x3")}</button></span></span><span class="surface-summary-actions"><span class="surface-separator" aria-hidden="true"></span><button class="icon-button surface-rebuild" title="重新生成三维表面" aria-label="重新生成三维表面">${icon("refresh-cw")}</button><button class="icon-button surface-remove" title="移除 Mask" aria-label="移除 Mask">${icon("trash-2")}</button></span></summary><div class="surface-label-controls"><span class="surface-palette" title="Mask colors" aria-hidden="true">${icon("palette")}</span><select class="surface-color-mode" aria-label="Mask colors"><option value="auto">Auto</option><option value="custom" hidden>Custom</option>${MASK_COLORS.map(({ name, color }) => `<option value="${color}">${name}</option>`).join("")}</select><input class="surface-color" type="color" aria-label="Mask 颜色" disabled hidden><span class="surface-separator" aria-hidden="true"></span><div class="surface-labels" aria-label="标签选择与显隐"></div><span class="surface-layer-status" role="status"></span></div>`;
    row.querySelector(".surface-filename")!.textContent = info.volume.name;
    row.querySelector<HTMLElement>(".surface-filename")!.title =
      info.volume.name;
    const layer: LayerView = {
      info,
      row,
      group: new Group(),
      status: row.querySelector(".surface-layer-status")!,
      labels: row.querySelector(".surface-labels")!,
      visible: true,
      color: labelColor(1),
      colorMode: "auto",
      opacity: 0.65,
      wireframe: false,
      hiddenLabels: new Set(),
      revision: -1,
      state: "idle",
    };
    layer.status.textContent = "Waiting for surface extraction…";
    this.group.add(layer.group);
    this.list.append(row);
    const button = (selector: string, action: () => void) => {
      const element = row.querySelector<HTMLButtonElement>(selector)!;
      element.onclick = (event) => {
        event.preventDefault();
        event.stopPropagation();
        action();
      };
      return element;
    };
    button(".surface-active", () =>
      this.post({ type: "selectOverlay", layerId: info.id }),
    );
    const visible = button(".surface-visible", () => {
      layer.visible = !layer.visible;
      layer.group.visible = layer.visible;
      visible.innerHTML = icon(layer.visible ? "eye" : "eye-off");
      visible.title = layer.visible ? "隐藏标签" : "显示标签";
      visible.setAttribute("aria-label", visible.title);
      visible.setAttribute("aria-pressed", String(layer.visible));
      this.displayChanged();
      this.render();
    });
    const color = row.querySelector<HTMLInputElement>(".surface-color")!;
    color.value = layer.color;
    const mode = row.querySelector<HTMLSelectElement>(".surface-color-mode")!;
    const custom = mode.querySelector<HTMLOptionElement>('[value="custom"]')!;
    mode.onchange = () => {
      layer.colorMode = mode.value === "auto" ? "auto" : "custom";
      if (mode.value !== "auto" && mode.value !== "custom") {
        layer.color = mode.value;
        color.value = layer.color;
      }
      custom.hidden = mode.value !== "custom";
      color.disabled = layer.colorMode === "auto";
      color.hidden = layer.colorMode === "auto";
      this.applyStyle(layer);
    };
    color.oninput = () => {
      layer.colorMode = "custom";
      custom.hidden = false;
      mode.value = "custom";
      color.disabled = false;
      color.hidden = false;
      layer.color = color.value;
      this.applyStyle(layer);
    };
    const opacity = row.querySelector<HTMLInputElement>(".surface-opacity")!;
    const output = row.querySelector("output")!;
    opacity.value = String(layer.opacity);
    output.textContent = "65%";
    opacity.oninput = () => {
      layer.opacity = Number(opacity.value);
      output.textContent = `${Math.round(layer.opacity * 100)}%`;
      this.applyStyle(layer);
    };
    const setMode = (wireframe: boolean) => {
      layer.wireframe = wireframe;
      row
        .querySelector(".surface-solid")!
        .setAttribute("aria-pressed", String(!wireframe));
      row
        .querySelector(".surface-wireframe")!
        .setAttribute("aria-pressed", String(wireframe));
      this.applyStyle(layer);
    };
    button(".surface-solid", () => setMode(false));
    button(".surface-wireframe", () => setMode(true));
    button(".surface-remove", () =>
      this.post({ type: "removeOverlay", layerId: info.id }),
    );
    button(".surface-rebuild", () =>
      this.post({
        type: "surface",
        layerId: info.id,
        frame: Number(
          (document.getElementById("frame") as HTMLInputElement).value,
        ),
        force: true,
      }),
    );
    return layer;
  }

  private add(layer: LayerView, data: SurfaceMesh) {
    const vertices = decode(data.vertices, true),
      indices = decode(data.indices, false);
    if (
      !vertices.length ||
      vertices.length % 3 ||
      indices.length % 3 ||
      !vertices.every(Number.isFinite) ||
      indices.some((n) => n >= vertices.length / 3)
    )
      throw new Error("3D mesh contains invalid coordinates or indices.");
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new BufferAttribute(vertices, 3));
    geometry.setIndex(new BufferAttribute(indices, 1));
    geometry.computeVertexNormals();
    const material = new MeshPhongMaterial({
      color: layer.colorMode === "auto" ? labelColor(data.label) : layer.color,
      side: DoubleSide,
      shininess: 35,
      opacity: layer.opacity,
      transparent: layer.opacity < 1,
      depthWrite: layer.opacity === 1,
      wireframe: layer.wireframe,
    });
    const mesh = new Mesh(geometry, material);
    mesh.userData.label = data.label;
    mesh.visible = !layer.hiddenLabels.has(data.label);
    layer.group.add(mesh);
    const pill = document.createElement("span");
    pill.className = "surface-label-pill";
    pill.dataset.label = String(data.label);
    pill.style.color =
      layer.colorMode === "auto" ? labelColor(data.label) : layer.color;
    const select = document.createElement("button");
    select.className = "surface-label-select";
    select.innerHTML = `<span class="surface-label-dot" aria-hidden="true">●</span> ${data.label}`;
    select.title = `选中标签 ${data.label}；双击定位`;
    select.setAttribute("aria-label", `选中标签 ${data.label}`);
    select.onclick = () => {
      layer.selectedLabel = data.label;
      this.updateSelection(layer);
      if (
        layer.row
          .querySelector(".surface-active")!
          .getAttribute("aria-pressed") !== "true"
      )
        this.post({ type: "selectOverlay", layerId: layer.info.id });
    };
    select.ondblclick = () => this.locateLabel(layer);
    const toggle = document.createElement("button");
    toggle.className = "surface-label-toggle";
    const updateToggle = () => {
      toggle.innerHTML = icon(mesh.visible ? "eye" : "eye-off");
      toggle.title = `${mesh.visible ? "隐藏" : "显示"}标签 ${data.label}`;
      toggle.setAttribute("aria-label", toggle.title);
      toggle.setAttribute("aria-pressed", String(mesh.visible));
      pill.dataset.visible = String(mesh.visible);
    };
    toggle.onclick = () => {
      mesh.visible = !mesh.visible;
      if (mesh.visible) layer.hiddenLabels.delete(data.label);
      else layer.hiddenLabels.add(data.label);
      updateToggle();
      this.displayChanged();
      this.render();
    };
    updateToggle();
    pill.append(select, toggle);
    layer.labels.append(pill);
  }

  private updateSelection(layer: LayerView) {
    for (const pill of layer.labels.querySelectorAll<HTMLElement>(
      ".surface-label-pill",
    )) {
      const selected = Number(pill.dataset.label) === layer.selectedLabel;
      pill.dataset.selected = String(selected);
      pill
        .querySelector(".surface-label-select")!
        .setAttribute("aria-pressed", String(selected));
    }
  }

  private labelLocation(layer: LayerView) {
    if (layer.state !== "ready" || layer.selectedLabel === undefined) return;
    const object = layer.group.children.find(
      (mesh) => mesh.userData.label === layer.selectedLabel,
    );
    const a = layer.info.volume.affine;
    if (!object || a.length !== 12 || !a.every(Number.isFinite)) return;
    const transform = new Matrix4().set(
      a[0],
      a[1],
      a[2],
      a[3],
      a[4],
      a[5],
      a[6],
      a[7],
      a[8],
      a[9],
      a[10],
      a[11],
      0,
      0,
      0,
      1,
    );
    const determinant = transform.determinant();
    if (!Number.isFinite(determinant) || determinant === 0) return;
    // Mesh vertices already carry the reference affine from surface extraction.
    // Invert that same Mask affine for slice indices; world xyz is never used
    // directly as voxel indices (also valid for oblique and sheared volumes).
    const box = new Box3().setFromObject(object);
    if (box.isEmpty()) return;
    const center = box.getCenter(new Vector3());
    const voxel = center.clone().applyMatrix4(transform.invert());
    if (![...center.toArray(), ...voxel.toArray()].every(Number.isFinite))
      return;
    return {
      center,
      voxel,
      radius: Math.max(box.getSize(new Vector3()).length() / 2, 0.001),
    };
  }

  private locateLabel(layer: LayerView) {
    const location = this.labelLocation(layer);
    if (!location) return;
    this.locate(layer.info.id, location.voxel.toArray());
    if (!this.renderer || !this.controls) return;
    const distance = this.frameCamera(
      this.camera,
      location.center,
      location.radius,
    );
    this.controls.target.copy(location.center);
    this.controls.minDistance = location.radius / 10;
    this.controls.maxDistance = distance * 10;
    this.controls.update();
    this.render();
  }

  private applyStyle(layer: LayerView) {
    for (const object of layer.group.children) {
      const material = (object as SurfaceObject).material;
      material.color.set(
        layer.colorMode === "auto"
          ? labelColor(object.userData.label)
          : layer.color,
      );
      material.opacity = layer.opacity;
      material.transparent = layer.opacity < 1;
      material.depthWrite = layer.opacity === 1;
      material.wireframe = layer.wireframe;
      material.needsUpdate = true;
    }
    for (const pill of layer.labels.querySelectorAll<HTMLElement>(
      ".surface-label-pill",
    ))
      pill.style.color =
        layer.colorMode === "auto"
          ? labelColor(Number(pill.dataset.label))
          : layer.color;
    this.displayChanged();
    this.render();
  }
  private triangleCount(layer: LayerView) {
    return layer.group.children.reduce(
      (n, object) => n + (object as SurfaceObject).geometry.index!.count / 3,
      0,
    );
  }
  private updateBounds() {
    if (![...this.layers.values()].some((layer) => layer.group.children.length))
      return;
    const bounds = new Box3().setFromObject(this.group);
    bounds.getCenter(this.center);
    this.radius = Math.max(bounds.getSize(new Vector3()).length() / 2, 0.001);
  }
  private refresh() {
    const files = [...this.layers.values()],
      populated = files.filter((layer) => layer.group.children.length);
    const triangles = populated.reduce(
      (n, layer) => n + this.triangleCount(layer),
      0,
    );
    this.reset.disabled = !triangles;
    this.message.hidden = !!triangles;
    if (!triangles)
      this.message.textContent = !files.length
        ? "Mask required"
        : files.some(
              (layer) => layer.state === "loading" || layer.state === "idle",
            )
          ? "Extracting surfaces. See the Mask module for progress."
          : "No surfaces to display. See the Mask module for details.";
    this.render();
  }

  private verifyPaint(layer: LayerView, triangles: number) {
    const target = new WebGLRenderTarget(128, 128);
    const visibility = [...this.layers.values()].map(
      (item) => [item, item.group.visible] as const,
    );
    const childVisibility = layer.group.children.map((mesh) => mesh.visible);
    const materials = layer.group.children.map((mesh) => {
      const m = (mesh as SurfaceObject).material;
      return {
        opacity: m.opacity,
        color: m.color.clone(),
        wireframe: m.wireframe,
        transparent: m.transparent,
        depthWrite: m.depthWrite,
      };
    });
    try {
      for (const item of this.layers.values())
        item.group.visible = item === layer;
      for (const object of layer.group.children) {
        object.visible = true;
        const material = (object as SurfaceObject).material;
        material.opacity = 1;
        material.color.set(0xffffff);
        material.wireframe = false;
        material.transparent = false;
        material.depthWrite = true;
        material.needsUpdate = true;
      }
      const camera = this.camera.clone();
      camera.aspect = 1;
      const box = new Box3().setFromObject(layer.group),
        center = box.getCenter(new Vector3());
      const radius = Math.max(box.getSize(new Vector3()).length() / 2, 0.001);
      this.frameCamera(camera, center, radius);
      this.renderer!.setRenderTarget(target);
      this.renderer!.render(this.scene, camera);
      const pixels = new Uint8Array(128 * 128 * 4);
      this.renderer!.readRenderTargetPixels(target, 0, 0, 128, 128, pixels);
      let visiblePixels = 0;
      for (let p = 0; p < pixels.length; p += 4)
        if (Math.max(pixels[p], pixels[p + 1], pixels[p + 2]) > 32)
          visiblePixels++;
      if (!visiblePixels)
        throw new Error(
          "Unable to render the 3D surface. Check VS Code WebGL support.",
        );
      this.post({
        type: "surfacePainted",
        layerId: layer.info.id,
        revision: layer.revision,
        triangles,
        visiblePixels,
      });
    } finally {
      for (const [item, visible] of visibility) item.group.visible = visible;
      layer.group.children.forEach((object, i) => {
        object.visible = childVisibility[i];
        const material = (object as SurfaceObject).material,
          saved = materials[i];
        material.opacity = saved.opacity;
        material.color.copy(saved.color);
        material.wireframe = saved.wireframe;
        material.transparent = saved.transparent;
        material.depthWrite = saved.depthWrite;
        material.needsUpdate = true;
      });
      this.renderer!.setRenderTarget(null);
      target.dispose();
      this.render();
    }
  }

  private initialize() {
    if (this.renderer) return;
    const renderer = new WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.domElement.setAttribute(
      "aria-label",
      "mask 三维表面对比，左键旋转，右键平移，滚轮缩放",
    );
    renderer.domElement.addEventListener("webglcontextlost", (event) => {
      event.preventDefault();
      this.message.hidden = false;
      this.message.textContent =
        "WebGL context lost. Regenerate surfaces after recovery.";
    });
    this.viewport.prepend(renderer.domElement);
    this.renderer = renderer;
    this.controls = new OrbitControls(this.camera, renderer.domElement);
    this.controls.addEventListener("change", () => this.render());
    this.resize();
  }
  private frameCamera(
    camera: PerspectiveCamera,
    center: Vector3,
    radius: number,
  ) {
    const vertical = (camera.fov * Math.PI) / 360;
    const halfFov = Math.min(
      vertical,
      Math.atan(Math.tan(vertical) * camera.aspect),
    );
    const distance = (radius / Math.sin(halfFov)) * 1.1;
    camera.position
      .copy(center)
      .add(new Vector3(1, -1.7, 0.9).normalize().multiplyScalar(distance));
    camera.near = Math.max(radius / 1000, 0.00001);
    camera.far = distance + radius * 100;
    camera.lookAt(center);
    camera.updateProjectionMatrix();
    return distance;
  }
  private home() {
    if (!this.renderer) return;
    this.updateBounds();
    const distance = this.frameCamera(this.camera, this.center, this.radius);
    this.controls!.target.copy(this.center);
    this.controls!.minDistance = this.radius / 10;
    this.controls!.maxDistance = distance * 10;
    this.controls!.update();
    this.render();
  }
  private resize() {
    if (!this.renderer) return;
    this.renderer.setSize(
      Math.max(1, this.viewport.clientWidth),
      Math.max(1, this.viewport.clientHeight),
    );
    this.camera.aspect =
      Math.max(1, this.viewport.clientWidth) /
      Math.max(1, this.viewport.clientHeight);
    this.camera.updateProjectionMatrix();
    this.render();
  }
  private render() {
    this.renderer?.render(this.scene, this.camera);
    this.updateCrosshair();
  }
  private clearLayer(layer: LayerView) {
    for (const object of [...layer.group.children]) {
      const mesh = object as SurfaceObject;
      mesh.geometry.dispose();
      mesh.material.dispose();
      layer.group.remove(mesh);
    }
    layer.labels.replaceChildren();
    this.updateSelection(layer);
  }
  private dispose() {
    this.observer.disconnect();
    this.controls?.dispose();
    for (const layer of this.layers.values()) this.clearLayer(layer);
    this.renderer?.dispose();
    this.crosshair.remove();
  }
}
