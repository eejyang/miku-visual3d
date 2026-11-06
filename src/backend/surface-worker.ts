import { parentPort, workerData } from "node:worker_threads";
import { RemoteVolume } from "./nifti";
import { flyingEdges } from "./flyingEdges";
import type { SurfaceUpdate, VolumeInfo } from "../protocol";

const post = (surface: SurfaceUpdate) => parentPort!.postMessage(surface);
function encode(values: Float32Array | Uint32Array): string {
  const bytes = Buffer.alloc(values.length * 4);
  for (let i = 0; i < values.length; i++) {
    if (values instanceof Float32Array) bytes.writeFloatLE(values[i], i * 4);
    else bytes.writeUInt32LE(values[i], i * 4);
  }
  return bytes.toString("base64");
}
async function run() {
  const { path, reference, frame } = workerData as {
    path: string;
    reference: VolumeInfo;
    frame: number;
  };
  let volume: RemoteVolume | undefined;
  try {
    // Reuse the host's decompressed file, with an independent file handle.
    // The session keeps its owner alive until the worker exits, even on cancel.
    volume = await RemoteVolume.open(path, "mask.nii", undefined, reference);
    const labels = await volume.labelFrame(frame);
    const meshes = flyingEdges(
      labels,
      reference.dimensions,
      reference.affine,
      (label) =>
        post({
          state: "loading",
          message: `Extracting surface for label ${label}…`,
        }),
    );
    post({
      state: "ready",
      frame,
      meshes: meshes.map((mesh) => ({
        label: mesh.label,
        vertices: encode(mesh.vertices),
        indices: encode(mesh.indices),
      })),
    });
  } catch (error) {
    post({
      state: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    await volume?.dispose();
    parentPort!.close();
  }
}
void run();
