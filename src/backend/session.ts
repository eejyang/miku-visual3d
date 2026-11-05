import { RemoteVolume } from "./nifti";
import { Worker } from "node:worker_threads";
import { join } from "node:path";
import type {
  Axis,
  ClientMessage,
  HostMessage,
  SliceRequest,
  VolumeInfo,
  SurfaceUpdate,
  SourceKind,
} from "../protocol";

export interface Source {
  path: string;
  name: string;
}
export interface Diagnostics {
  sourceKind: SourceKind;
  ready: boolean;
  loaded: boolean;
  requests: number;
  sent: number;
  painted: Partial<
    Record<
      Axis,
      { id: number; width: number; height: number; visiblePixels: number }
    >
  >;
  errors: string[];
  surface?: { triangles: number; visiblePixels: number };
  surfaces: Record<
    string,
    { name: string; triangles: number; visiblePixels: number }
  >;
  surfaceErrors: Record<string, string>;
}
export interface Host {
  post(message: HostMessage): void;
  pickOverlay(): Promise<Source | Source[] | undefined>;
  log(message: string): void;
}

interface Layer {
  id: string;
  volume: RemoteVolume;
  sourcePath: string;
  key: string;
  revision: number;
}
interface SurfaceRequest {
  layer: Layer;
  frame: number;
  revision: number;
}

/** File I/O stays on the extension host; only this bounded protocol reaches the UI. */
export class ViewerSession {
  readonly diagnostics: Diagnostics = {
    sourceKind: "image",
    ready: false,
    loaded: false,
    requests: 0,
    sent: 0,
    painted: {},
    errors: [],
    surfaces: {},
    surfaceErrors: {},
  };
  private base?: RemoteVolume;
  private overlay?: RemoteVolume;
  private activeId?: string;
  private sourceKind: SourceKind = "image";
  private layers = new Map<string, Layer>();
  private layerSerial = 0;
  private overlayEpoch = 0;
  private opening = false;
  private picking = false;
  private closed = false;
  private abort = new AbortController();
  private volumes = new Set<RemoteVolume>();
  private pending = new Map<Axis, SliceRequest>();
  private revisions = [0, 0, 0];
  private layerRevision = 0;
  private draining?: Promise<void>;
  private loads = new Set<Promise<RemoteVolume>>();
  private classifying?: Promise<SourceKind>;
  private surfaceWorker?: Worker;
  private surfacePending = new Map<string, SurfaceRequest>();
  private surfaceJobs = new Map<
    Worker,
    { volume: RemoteVolume; layerId: string; done: Promise<void> }
  >();

  constructor(
    private source: Source,
    private host: Host,
    private surfaceWorkerPath = join(__dirname, "surface-worker.cjs"),
  ) {}
  private post(message: HostMessage) {
    if (!this.closed) this.host.post(message);
  }
  private fail(error: unknown, id?: number) {
    const message = error instanceof Error ? error.message : String(error);
    this.diagnostics.errors.push(message);
    this.host.log(`ERROR: ${message}`);
    this.post({ type: "error", message, id });
  }

  private async load(
    source: Source,
    reference?: VolumeInfo,
  ): Promise<RemoteVolume> {
    if (!/\.nii(\.gz)?$/i.test(source.path))
      throw new Error("请选择 .nii 或 .nii.gz 文件。");
    this.host.log(`Opening ${source.name}`);
    const task = RemoteVolume.open(
      source.path,
      source.name,
      this.abort.signal,
      reference,
    );
    this.loads.add(task);
    try {
      const volume = await task;
      if (this.closed) {
        await volume.dispose();
        throw new Error("Viewer closed.");
      }
      this.volumes.add(volume);
      return volume;
    } finally {
      this.loads.delete(task);
    }
  }

  async receive(input: unknown): Promise<void> {
    if (
      this.closed ||
      !input ||
      typeof input !== "object" ||
      !("type" in input)
    )
      return;
    const message = input as ClientMessage;
    try {
      switch (message.type) {
        case "ready":
          this.diagnostics.ready = true;
          if (this.base && !this.opening) {
            this.post({
              type: "volume",
              volume: this.base.info,
              sourceKind: this.sourceKind,
            });
            return;
          }
          if (this.opening) {
            this.post({
              type: "status",
              message: "正在读取影像，压缩文件首次打开需先在工作区主机解压…",
            });
            return;
          }
          this.opening = true;
          this.post({ type: "status", message: "正在工作区主机读取影像…" });
          try {
            this.base = await this.load(this.source);
            this.post({
              type: "status",
              message: "正在统计灰度种类，自动识别影像或分割 mask…",
            });
            this.classifying = this.base.classifySource(this.abort.signal);
            this.sourceKind = await this.classifying;
            if (this.closed) return;
            this.diagnostics.sourceKind = this.sourceKind;
            this.diagnostics.loaded = true;
            this.host.log(
              `Loaded ${this.base.info.dimensions.join("×")}, ${this.base.info.frames} frame(s)`,
            );
            this.post({
              type: "volume",
              volume: this.base.info,
              sourceKind: this.sourceKind,
            });
            if (this.sourceKind === "mask") this.attachSourceMask();
          } catch (error) {
            const failed = this.base;
            this.base = undefined;
            if (failed) {
              this.volumes.delete(failed);
              await failed.dispose();
            }
            throw error;
          } finally {
            this.opening = false;
            this.classifying = undefined;
          }
          break;
        case "slice": {
          const r = message.request;
          if (
            !r ||
            !Number.isSafeInteger(r.id) ||
            ![0, 1, 2].includes(r.axis) ||
            !Number.isInteger(r.index) ||
            !Number.isInteger(r.frame)
          )
            return;
          if (!this.base) throw new Error("影像尚未读入，请稍候。");
          this.diagnostics.requests++;
          this.pending.set(r.axis, { ...r });
          this.revisions[r.axis]++;
          this.drain();
          break;
        }
        case "overlay":
          await this.addOverlay();
          break;
        case "removeOverlay":
          this.removeLayer(message.layerId ?? this.activeId);
          break;
        case "selectOverlay": {
          const layer = this.layers.get(message.layerId);
          if (!layer || this.activeId === layer.id) break;
          this.activeId = layer.id;
          this.overlay = layer.volume;
          this.layerRevision++;
          this.postLayers();
          break;
        }
        case "surface":
          if (
            this.base &&
            Number.isInteger(message.frame) &&
            message.frame >= 0 &&
            message.frame < this.base.info.frames
          ) {
            for (const layer of this.layers.values())
              if (!message.layerId || layer.id === message.layerId)
                this.scheduleSurface(layer, message.frame, !!message.force);
            this.pumpSurface();
          }
          break;
        case "surfacePainted": {
          const layer = this.layers.get(message.layerId);
          if (
            layer &&
            layer.revision === message.revision &&
            Number.isSafeInteger(message.triangles) &&
            message.triangles > 0 &&
            Number.isSafeInteger(message.visiblePixels) &&
            message.visiblePixels > 0
          ) {
            this.diagnostics.surfaces[layer.id] = {
              name: layer.volume.info.name,
              triangles: message.triangles,
              visiblePixels: message.visiblePixels,
            };
            delete this.diagnostics.surfaceErrors[layer.id];
            this.aggregateSurfaces();
            this.host.log(
              `Painted surface ${layer.id} (${layer.volume.info.name}), ${message.triangles} triangles, ${message.visiblePixels} visible pixels`,
            );
          }
          break;
        }
        case "surfaceClientError": {
          const layer = this.layers.get(message.layerId);
          if (layer && layer.revision === message.revision) {
            this.diagnostics.surfaceErrors[layer.id] = String(
              message.message,
            ).slice(0, 2000);
            this.host.log(
              `Surface ${layer.id}: ${this.diagnostics.surfaceErrors[layer.id]}`,
            );
          }
          break;
        }
        case "painted":
          if (
            [0, 1, 2].includes(message.axis) &&
            Number.isInteger(message.id) &&
            Number.isFinite(message.visiblePixels)
          ) {
            this.diagnostics.painted[message.axis] = {
              id: message.id,
              width: message.width,
              height: message.height,
              visiblePixels: message.visiblePixels,
            };
            this.host.log(
              `Painted plane ${message.axis}, ${message.width}×${message.height}, visible pixels ${message.visiblePixels}`,
            );
          }
          break;
        case "clientError":
          this.fail(`界面错误：${String(message.message).slice(0, 2000)}`);
          break;
      }
    } catch (error) {
      if (!this.closed) this.fail(error);
    }
  }

  private postLayers(): void {
    this.post({
      type: "overlay",
      volume: this.overlay?.info ?? null,
      activeId: this.activeId,
      layers: [...this.layers.values()].map((layer) => ({
        id: layer.id,
        volume: layer.volume.info,
      })),
    });
  }

  private removeLayer(id?: string): void {
    const layer = id ? this.layers.get(id) : undefined;
    if (!layer) return;
    this.stopSurface(layer);
    this.layers.delete(layer.id);
    if (this.activeId === layer.id)
      this.activeId = [...this.layers.keys()].at(-1);
    this.overlay = this.activeId
      ? this.layers.get(this.activeId)?.volume
      : undefined;
    this.layerRevision++;
    this.postLayers();
    this.retire();
    this.pumpSurface();
  }

  private attachSourceMask(): void {
    if (!this.base) return;
    let layer = [...this.layers.values()].find(
      (layer) =>
        layer.volume === this.base || layer.sourcePath === this.source.path,
    );
    if (!layer) {
      layer = {
        id: `mask-${++this.layerSerial}`,
        volume: this.base,
        sourcePath: this.source.path,
        key: "",
        revision: 0,
      };
      this.layers.set(layer.id, layer);
    }
    this.activeId = layer.id;
    this.overlay = layer.volume;
    this.layerRevision++;
    this.postLayers();
  }

  async addOverlay(source?: Source | Source[]): Promise<void> {
    if (!this.base || this.picking || this.closed) return;
    this.picking = true;
    const epoch = this.overlayEpoch;
    try {
      source ??= await this.host.pickOverlay();
      if (!source || this.closed || epoch !== this.overlayEpoch) return;
      for (const item of Array.isArray(source) ? source : [source]) {
        if (this.closed || epoch !== this.overlayEpoch) break;
        try {
          let layer = [...this.layers.values()].find(
            (layer) => layer.sourcePath === item.path,
          );
          if (!layer) {
            this.post({ type: "status", message: `正在读取 ${item.name}…` });
            const candidate = await this.load(item, this.base.info);
            if (this.closed || epoch !== this.overlayEpoch) break;
            layer = {
              id: `mask-${++this.layerSerial}`,
              volume: candidate,
              sourcePath: item.path,
              key: "",
              revision: 0,
            };
            this.layers.set(layer.id, layer);
          }
          this.activeId = layer.id;
          this.overlay = layer.volume;
          this.layerRevision++;
          this.postLayers();
        } catch (error) {
          if (!this.closed) this.fail(error);
        }
      }
    } catch (error) {
      if (!this.closed) this.fail(error);
    } finally {
      this.picking = false;
      this.retire();
    }
  }

  private aggregateSurfaces(): void {
    const values = Object.values(this.diagnostics.surfaces);
    this.diagnostics.surface = values.length
      ? {
          triangles: values.reduce((sum, value) => sum + value.triangles, 0),
          visiblePixels: values.reduce(
            (sum, value) => sum + value.visiblePixels,
            0,
          ),
        }
      : undefined;
  }

  private stopSurface(layer: Layer): void {
    layer.key = "";
    layer.revision++;
    this.surfacePending.delete(layer.id);
    delete this.diagnostics.surfaces[layer.id];
    delete this.diagnostics.surfaceErrors[layer.id];
    this.aggregateSurfaces();
    for (const [worker, job] of this.surfaceJobs) {
      if (job.layerId === layer.id) {
        if (this.surfaceWorker === worker) this.surfaceWorker = undefined;
        void worker.terminate();
      }
    }
  }

  private scheduleSurface(layer: Layer, frame: number, force: boolean): void {
    const effectiveFrame = layer.volume.info.frames === 1 ? 0 : frame;
    const key = String(effectiveFrame);
    if (!force && key === layer.key) return;
    this.stopSurface(layer);
    layer.key = key;
    this.surfacePending.set(layer.id, {
      layer,
      frame: effectiveFrame,
      revision: layer.revision,
    });
    this.post({
      type: "surface",
      layerId: layer.id,
      revision: layer.revision,
      surface: { state: "loading", message: "等待工作区主机提取表面…" },
    });
  }

  private pumpSurface(): void {
    // Serialize workers across files to bound host memory during comparisons.
    if (this.closed || this.surfaceJobs.size || !this.base) return;
    const request = this.surfacePending.values().next().value;
    if (!request) return;
    const { layer, frame, revision } = request;
    this.surfacePending.delete(layer.id);
    if (this.layers.get(layer.id) !== layer || layer.revision !== revision) {
      this.pumpSurface();
      return;
    }
    const current = () =>
      !this.closed &&
      this.layers.get(layer.id) === layer &&
      layer.revision === revision;
    let received = false;
    const post = (surface: SurfaceUpdate) => {
      if (!current()) return;
      if (surface.state === "ready" || surface.state === "error")
        received = true;
      if (surface.state === "error") {
        layer.key = "";
        this.diagnostics.surfaceErrors[layer.id] = surface.message;
        this.host.log(`Surface ${layer.id}: ${surface.message}`);
      }
      this.post({ type: "surface", layerId: layer.id, revision, surface });
    };
    let worker: Worker;
    try {
      worker = new Worker(this.surfaceWorkerPath, {
        workerData: {
          path: layer.volume.hostPath,
          reference: this.base.info,
          frame,
        },
        resourceLimits: { maxOldGenerationSizeMb: 512 },
      });
    } catch (error) {
      post({ state: "error", message: String(error) });
      this.pumpSurface();
      return;
    }
    this.surfaceWorker = worker;
    worker.on("message", post);
    worker.on("error", (error) =>
      post({ state: "error", message: error.message }),
    );
    const done = new Promise<void>((resolve) =>
      worker.once("exit", (code) => {
        if (current() && (!received || code !== 0))
          post({
            state: "error",
            message: `三维表面计算退出（${code}），可点击重新生成。`,
          });
        if (this.surfaceWorker === worker) this.surfaceWorker = undefined;
        this.surfaceJobs.delete(worker);
        this.retire();
        this.pumpSurface();
        resolve();
      }),
    );
    this.surfaceJobs.set(worker, {
      volume: layer.volume,
      layerId: layer.id,
      done,
    });
  }

  private drain(): void {
    if (this.draining || this.closed || !this.base) return;
    this.draining = this.renderPending().finally(() => {
      this.draining = undefined;
      this.retire();
    });
  }
  private async renderPending(): Promise<void> {
    while (this.pending.size && !this.closed) {
      const [axis, request] = this.pending.entries().next().value!;
      this.pending.delete(axis);
      const revision = this.revisions[axis],
        layers = this.layerRevision;
      const cancelled = () =>
        this.closed ||
        revision !== this.revisions[axis] ||
        layers !== this.layerRevision;
      try {
        const base = await this.base!.slice(request, cancelled);
        const layer = this.overlay;
        const overlay =
          layer === this.base
            ? base
            : base && layer
              ? await layer.slice(
                  {
                    ...request,
                    frame: layer.info.frames === 1 ? 0 : request.frame,
                  },
                  cancelled,
                )
              : undefined;
        if (base && !cancelled()) {
          this.diagnostics.sent++;
          this.post({
            type: "slice",
            request,
            base,
            overlay: overlay ?? undefined,
          });
        }
      } catch (error) {
        if (!cancelled()) this.fail(error, request.id);
      }
    }
  }
  private retire(): void {
    if (this.draining) return;
    for (const v of this.volumes) {
      if (
        v !== this.base &&
        ![...this.layers.values()].some((layer) => layer.volume === v) &&
        ![...this.surfaceJobs.values()].some((job) => job.volume === v)
      ) {
        this.volumes.delete(v);
        void v
          .dispose()
          .catch((error) => this.host.log(`Cleanup: ${String(error)}`));
      }
    }
  }
  async dispose(): Promise<void> {
    this.closed = true;
    this.overlayEpoch++;
    for (const layer of this.layers.values()) this.stopSurface(layer);
    this.surfacePending.clear();
    this.abort.abort();
    this.pending.clear();
    await Promise.allSettled([
      ...(this.draining ? [this.draining] : []),
      ...this.loads,
      ...(this.classifying ? [this.classifying] : []),
      ...[...this.surfaceJobs.values()].map((job) => job.done),
    ]);
    await Promise.allSettled([...this.volumes].map((v) => v.dispose()));
    this.volumes.clear();
  }
}
