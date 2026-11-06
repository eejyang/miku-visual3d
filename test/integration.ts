import * as vscode from "vscode";
import { strict as assert } from "node:assert";
import { access, copyFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import type { Diagnostics } from "../src/backend/session";

interface ExtensionApi {
  getDiagnostics(): Record<string, Diagnostics>;
}
async function waitForPaint(api: ExtensionApi, uri: vscode.Uri) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const state = api.getDiagnostics()[uri.toString()];
    if (state?.errors.length) throw new Error(JSON.stringify(state));
    if (
      state &&
      [0, 1, 2].every(
        (axis) => state.painted[axis as 0 | 1 | 2]?.visiblePixels! > 0,
      )
    )
      return state;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `Real webview did not paint: ${JSON.stringify(api.getDiagnostics())}`,
  );
}
async function synthetic(path: string, mask = false, shift = 0) {
  const dim = 48,
    voxels = dim ** 3,
    bytes = Buffer.alloc(352 + voxels * 2);
  bytes.writeInt32LE(348, 0);
  bytes.set([110, 43, 49, 0], 344);
  bytes.writeInt16LE(3, 40);
  for (let i = 0; i < 3; i++) {
    bytes.writeInt16LE(dim, 42 + i * 2);
    bytes.writeFloatLE(1, 80 + i * 4);
  }
  bytes.writeInt16LE(4, 70);
  bytes.writeInt16LE(16, 72);
  bytes.writeFloatLE(352, 108);
  bytes.writeFloatLE(1, 112);
  for (let z = 0; z < dim; z++)
    for (let y = 0; y < dim; y++)
      for (let x = 0; x < dim; x++) {
        const r =
          ((x - dim / 2 - shift) ** 2 +
            (y - dim / 2) ** 2 +
            (z - dim / 2) ** 2) /
          (dim * 0.4) ** 2;
        bytes.writeInt16LE(
          r < 1
            ? mask
              ? x < dim / 2
                ? 1
                : 2
              : Math.round(1000 * (1 - r))
            : 0,
          352 + (x + dim * (y + dim * z)) * 2,
        );
      }
  await writeFile(path, gzipSync(bytes));
}
async function waitForSurfaces(
  api: ExtensionApi,
  uri: vscode.Uri,
  count: number,
) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const state = api.getDiagnostics()[uri.toString()];
    if (Object.keys(state?.surfaceErrors ?? {}).length || state?.errors.length)
      throw new Error(`Surface render failed: ${JSON.stringify(state)}`);
    if (Object.keys(state?.surfaces ?? {}).length === count) return state;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `Surface render timed out: ${JSON.stringify(api.getDiagnostics())}`,
  );
}

export async function run() {
  const root = process.env.MIKU_VISUAL_TEST_ROOT!,
    scratch = process.env.MIKU_VISUAL_TEST_SCRATCH!;
  const extension = vscode.extensions.getExtension<ExtensionApi>(
    "miku-local.miku-visual3d",
  );
  assert(extension, "Independent extension was not discovered");
  const api = await extension.activate();
  const sample = join(scratch, "synthetic.nii.gz");
  await synthetic(sample);
  const sampleMask = join(scratch, "synthetic-mask.nii.gz");
  await synthetic(sampleMask, true);
  const samplePrediction = join(scratch, "synthetic-prediction.nii.gz");
  await synthetic(samplePrediction, true, 2);
  const files = [sample];
  const masks = new Map([[sample, [sampleMask, samplePrediction]]]);
  try {
    await access(join(root, "mri.nii.gz"));
    files.push(join(root, "mri.nii.gz"));
  } catch {
    /* Optional local MRI. */
  }
  try {
    const ct = join(root, "assets", "ct.nii.gz"),
      mask = join(root, "assets", "ct_mask.nii.gz");
    await Promise.all([access(ct), access(mask)]);
    files.push(ct);
    const gt = join(scratch, "ct-mask-GT-copy.nii.gz");
    await copyFile(mask, gt);
    masks.set(ct, [mask, gt]);
  } catch {
    /* Optional local CT and mask. */
  }
  const results = [];
  for (const path of files) {
    const uri = vscode.Uri.file(path);
    await vscode.commands.executeCommand(
      "vscode.openWith",
      uri,
      "mikuVisual.image",
    );
    let state = await waitForPaint(api, uri);
    if (masks.has(path)) {
      await vscode.commands.executeCommand(
        "mikuVisual.addOverlay",
        masks.get(path)!.map((mask) => vscode.Uri.file(mask)),
      );
      const deadline = Date.now() + 60000;
      while (
        Date.now() < deadline &&
        Object.keys(api.getDiagnostics()[uri.toString()]?.surfaces ?? {})
          .length < masks.get(path)!.length
      ) {
        const current = api.getDiagnostics()[uri.toString()];
        if (
          Object.keys(current?.surfaceErrors ?? {}).length ||
          current?.errors.length
        )
          throw new Error(`3D comparison failed: ${JSON.stringify(current)}`);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      state = api.getDiagnostics()[uri.toString()];
      assert(
        state.surface?.visiblePixels! > 0,
        `3D GPU readback failed: ${JSON.stringify(state)}`,
      );
      assert(state.surface?.triangles! > 0);
      assert.equal(Object.keys(state.surfaces).length, masks.get(path)!.length);
      assert(
        Object.values(state.surfaces).every(
          (surface) => surface.triangles > 0 && surface.visiblePixels > 0,
        ),
      );
    }
    assert.equal(state.ready, true);
    assert.equal(state.loaded, true);
    results.push({ file: uri.path.split("/").pop(), ...state });
    console.log("MIKU_VISUAL_RENDERED", JSON.stringify(results.at(-1)));
    if (path === files.at(-1) && process.env.MIKU_VISUAL_TEST_HOLD_MS)
      await new Promise((resolve) =>
        setTimeout(resolve, Number(process.env.MIKU_VISUAL_TEST_HOLD_MS)),
      );
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  }
  // The ordinary image-opening command must detect masks without a background.
  // Use the real sparse CT mask too when it is available.
  const standaloneMasks = [sampleMask];
  try {
    await access(join(root, "assets", "ct_mask.nii.gz"));
    standaloneMasks.push(join(root, "assets", "ct_mask.nii.gz"));
  } catch {
    /* Optional. */
  }
  for (const path of standaloneMasks) {
    const uri = vscode.Uri.file(path);
    await vscode.commands.executeCommand("mikuVisual.open", uri);
    await waitForPaint(api, uri);
    let state = await waitForSurfaces(api, uri, 1);
    assert.equal(state.sourceKind, "mask");
    if (path === sampleMask) {
      await vscode.commands.executeCommand(
        "mikuVisual.addOverlay",
        vscode.Uri.file(samplePrediction),
      );
      state = await waitForSurfaces(api, uri, 2);
    }
    results.push({
      file: uri.path.split("/").pop(),
      standaloneMask: true,
      ...state,
    });
    console.log("MIKU_VISUAL_STANDALONE_MASK", JSON.stringify(results.at(-1)));
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  }
  await writeFile(
    join(root, "dist/integration-result.json"),
    JSON.stringify({ realVSCode: true, results }, null, 2),
  );
}
