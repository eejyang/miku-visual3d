// Only metadata, requested 2D pixels and extracted meshes cross the boundary.
export type Axis = 0 | 1 | 2;
export type SourceKind = "image" | "mask";

export interface VolumeInfo {
  name: string;
  dimensions: number[];
  spacing: number[];
  frames: number;
  affine: number[];
  spatialUnits: number;
  hasOrientation: boolean;
}

export interface SliceRequest {
  id: number;
  axis: Axis;
  index: number;
  frame: number;
}

export interface SlicePixels {
  width: number;
  height: number;
  // Base64 little-endian Float32 pixels; bounded to one 1024² plane.
  pixels: string;
  min: number;
  max: number;
}

export interface SurfaceMesh {
  label: number;
  vertices: string; // Base64 little-endian Float32 xyz in the base image's space.
  indices: string; // Base64 little-endian Uint32 triangle indices.
}

export interface OverlayLayer {
  id: string;
  volume: VolumeInfo;
}

export type SurfaceUpdate =
  | { state: "idle" | "loading" | "error"; message: string }
  | { state: "ready"; meshes: SurfaceMesh[]; frame: number };

export type ClientMessage =
  | { type: "ready" }
  | { type: "openImage" }
  | { type: "slice"; request: SliceRequest }
  | { type: "overlay" }
  | { type: "removeOverlay"; layerId?: string }
  | { type: "selectOverlay"; layerId: string }
  | { type: "surface"; frame: number; force?: boolean; layerId?: string }
  | {
      type: "surfacePainted";
      layerId: string;
      revision: number;
      triangles: number;
      visiblePixels: number;
    }
  | {
      type: "surfaceClientError";
      layerId: string;
      revision: number;
      message: string;
    }
  | {
      type: "painted";
      id: number;
      axis: Axis;
      width: number;
      height: number;
      visiblePixels: number;
    }
  | { type: "clientError"; message: string };

export type HostMessage =
  | { type: "volume"; volume: VolumeInfo; sourceKind: SourceKind }
  | {
      type: "overlay";
      volume: VolumeInfo | null;
      layers: OverlayLayer[];
      activeId?: string;
    }
  | {
      type: "surface";
      layerId: string;
      revision: number;
      surface: SurfaceUpdate;
    }
  | {
      type: "slice";
      request: SliceRequest;
      base: SlicePixels;
      overlay?: SlicePixels;
    }
  | { type: "status"; message: string }
  | { type: "error"; message: string; id?: number };
