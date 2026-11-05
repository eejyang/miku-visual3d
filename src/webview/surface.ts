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
  MeshPhongMaterial,
  PerspectiveCamera,
  Scene,
  Vector3,
  WebGLRenderer,
  WebGLRenderTarget,
} from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { OverlayLayer, SurfaceMesh, SurfaceUpdate } from "../protocol";

const palette = [
  "#50bde9",
  "#f5aa54",
  "#a98cf5",
  "#69d6a3",
  "#f07fa4",
  "#e0d465",
  "#78a4f5",
  "#db8e60",
];
type SurfaceObject = Mesh<BufferGeometry, MeshPhongMaterial>;
interface LayerView {
  info: OverlayLayer;
  group: Group;
  row: HTMLElement;
  status: HTMLElement;
  labels: HTMLElement;
  legend: HTMLButtonElement;
  displayName: string;
  visible: boolean;
  color: string;
  opacity: number;
  wireframe: boolean;
  hiddenLabels: Set<number>;
  revision: number;
  state: SurfaceUpdate["state"];
}
function decode(
  encoded: string,
  floating: boolean,
): Float32Array | Uint32Array {
  const bytes = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
  if (bytes.length % 4) throw new Error("三维网格数据长度错误。");
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
  private colorSerial = 0;
  private camera = new PerspectiveCamera(35, 1, 0.01, 10000);
  private controls?: OrbitControls;
  private observer: ResizeObserver;
  private radius = 1;
  private center = new Vector3();
  private hasFramed = false;
  private message = document.getElementById("renderMessage")!;
  private count = document.getElementById("renderCount")!;
  private legend = document.getElementById("renderLegend")!;
  private manager = document.getElementById(
    "surfaceManager",
  ) as HTMLDetailsElement;
  private list = document.getElementById("surfaceLayers")!;
  private reset = document.getElementById("resetSurface") as HTMLButtonElement;
  private rebuild = document.getElementById(
    "rebuildSurface",
  ) as HTMLButtonElement;

  constructor(
    private viewport: HTMLElement,
    private post: (value: unknown) => void,
  ) {
    this.scene.background = new Color("#08090b");
    this.scene.add(this.group, new AmbientLight(0xffffff, 1.1));
    const key = new DirectionalLight(0xffffff, 2.5);
    key.position.set(1, -2, 3);
    const fill = new DirectionalLight(0xb7d2ff, 1.3);
    fill.position.set(-2, 1, -1);
    this.scene.add(key, fill);
    this.camera.up.set(0, 0, 1);
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
        layer.legend.remove();
        this.layers.delete(id);
      }
    let added = false;
    for (const info of infos) {
      const existing = this.layers.get(info.id);
      if (existing) existing.info = info;
      else {
        this.layers.set(info.id, this.createLayer(info));
        added = true;
      }
    }
    this.manager.hidden = !this.layers.size;
    if (added && this.layers.size > 1) this.manager.open = true;
    document.getElementById("surfaceLayerCount")!.textContent =
      `（${this.layers.size}）`;
    this.rebuild.disabled = !this.layers.size;
    if (!this.layers.size) this.hasFramed = false;
    this.refresh();
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
      if (update.state !== "ready") {
        layer.status.textContent = update.message;
        this.refresh();
        return;
      }
      if (!update.meshes.length) {
        layer.status.textContent = "当前帧全为背景";
        this.refresh();
        return;
      }
      this.initialize();
      update.meshes.forEach((mesh) => this.add(layer, mesh));
      const triangles = this.triangleCount(layer);
      layer.status.textContent = `${update.meshes.length} 标签 · ${triangles.toLocaleString()} 面`;
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
      layer.status.textContent = `三维显示失败：${error instanceof Error ? error.message : String(error)}`;
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
    const row = document.createElement("section");
    row.className = "surface-layer";
    row.dataset.layerId = info.id;
    row.innerHTML = `<div class="surface-layer-controls"><label><input class="surface-visible" type="checkbox" checked>显示</label><input class="surface-name" type="text" aria-label="表面名称，例如 GT 或 Prediction"><input class="surface-color" type="color" aria-label="表面颜色"><label>不透明度 <input class="surface-opacity" type="range" min="0" max="1" step="0.05"><output></output></label><label><input class="surface-wireframe" type="checkbox">线框</label><button class="surface-rebuild">重新生成</button><button class="surface-remove">移除</button><span class="surface-layer-status"></span></div><div class="surface-labels" aria-label="独立标签显隐"></div>`;
    const legend = document.createElement("button");
    const layer: LayerView = {
      info,
      row,
      legend,
      group: new Group(),
      status: row.querySelector(".surface-layer-status")!,
      labels: row.querySelector(".surface-labels")!,
      displayName: info.volume.name,
      visible: true,
      color: palette[this.colorSerial++ % palette.length],
      opacity: 0.65,
      wireframe: false,
      hiddenLabels: new Set(),
      revision: -1,
      state: "idle",
    };
    layer.status.textContent = "等待提取表面…";
    this.group.add(layer.group);
    this.list.append(row);
    this.legend.append(legend);
    const name = row.querySelector<HTMLInputElement>(".surface-name")!;
    name.value = layer.displayName;
    name.title = info.volume.name;
    const updateLegend = () => {
      legend.textContent = `● ${layer.displayName}`;
      legend.title = `${layer.displayName}：点击显示或隐藏全部标签`;
      legend.style.color = layer.color;
      legend.setAttribute("aria-pressed", String(layer.visible));
    };
    const visible = row.querySelector<HTMLInputElement>(".surface-visible")!;
    const setVisible = (value: boolean) => {
      layer.visible = value;
      visible.checked = value;
      layer.group.visible = value;
      updateLegend();
      this.render();
    };
    visible.onchange = () => setVisible(visible.checked);
    legend.onclick = () => setVisible(!layer.visible);
    name.oninput = () => {
      layer.displayName = name.value.trim() || info.volume.name;
      updateLegend();
    };
    const color = row.querySelector<HTMLInputElement>(".surface-color")!;
    color.value = layer.color;
    color.oninput = () => {
      layer.color = color.value;
      this.applyStyle(layer);
      updateLegend();
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
    const wireframe =
      row.querySelector<HTMLInputElement>(".surface-wireframe")!;
    wireframe.onchange = () => {
      layer.wireframe = wireframe.checked;
      this.applyStyle(layer);
    };
    row.querySelector<HTMLButtonElement>(".surface-remove")!.onclick = () =>
      this.post({ type: "removeOverlay", layerId: info.id });
    row.querySelector<HTMLButtonElement>(".surface-rebuild")!.onclick = () =>
      this.post({
        type: "surface",
        layerId: info.id,
        frame: Number(
          (document.getElementById("frame") as HTMLInputElement).value,
        ),
        force: true,
      });
    updateLegend();
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
      throw new Error("三维网格包含无效坐标或索引。");
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new BufferAttribute(vertices, 3));
    geometry.setIndex(new BufferAttribute(indices, 1));
    geometry.computeVertexNormals();
    const material = new MeshPhongMaterial({
      color: layer.color,
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
    const toggle = document.createElement("button");
    toggle.textContent = `标签 ${data.label}`;
    toggle.setAttribute("aria-pressed", String(mesh.visible));
    toggle.onclick = () => {
      mesh.visible = !mesh.visible;
      if (mesh.visible) layer.hiddenLabels.delete(data.label);
      else layer.hiddenLabels.add(data.label);
      toggle.setAttribute("aria-pressed", String(mesh.visible));
      this.render();
    };
    layer.labels.append(toggle);
  }

  private applyStyle(layer: LayerView) {
    for (const object of layer.group.children) {
      const material = (object as SurfaceObject).material;
      material.color.set(layer.color);
      material.opacity = layer.opacity;
      material.transparent = layer.opacity < 1;
      material.depthWrite = layer.opacity === 1;
      material.wireframe = layer.wireframe;
      material.needsUpdate = true;
    }
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
    this.count.textContent = `${files.length} 份 · ${triangles.toLocaleString()} 面`;
    this.reset.disabled = !triangles;
    this.message.hidden = !!triangles;
    if (!triangles)
      this.message.textContent = !files.length
        ? "添加标签 mask 后显示三维表面"
        : files.some(
              (layer) => layer.state === "loading" || layer.state === "idle",
            )
          ? "正在提取表面，可展开上方“表面标签”查看进度"
          : "没有可显示的表面，请展开“表面标签”查看详情";
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
        throw new Error("三维表面未能绘制，请检查 VS Code WebGL 支持。");
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
      this.message.textContent = "三维图形上下文已丢失，恢复后请点击重新生成";
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
  }
  private clearLayer(layer: LayerView) {
    for (const object of [...layer.group.children]) {
      const mesh = object as SurfaceObject;
      mesh.geometry.dispose();
      mesh.material.dispose();
      layer.group.remove(mesh);
    }
    layer.labels.replaceChildren();
  }
  private dispose() {
    this.observer.disconnect();
    this.controls?.dispose();
    for (const layer of this.layers.values()) this.clearLayer(layer);
    this.renderer?.dispose();
  }
}
