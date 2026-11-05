import { runTests } from "@vscode/test-electron";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { build } from "esbuild";

const root = resolve(import.meta.dirname, "..");
// Keep macOS's Unix-domain IPC socket path under its length limit.
const scratch = await mkdtemp(
  resolve(process.platform === "darwin" ? "/tmp" : tmpdir(), "mv-test-"),
);
await mkdir(resolve(scratch, "extensions"));
await build({
  entryPoints: [resolve(root, "test/integration.ts")],
  outfile: resolve(root, "dist/integration.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["vscode"],
  target: "node18",
});
const installed = [
  "/Applications/Visual Studio Code.app/Contents/MacOS/Code",
  "/Applications/Visual Studio Code.app/Contents/MacOS/Electron",
].find(existsSync);
// A terminal hosted by VS Code inherits Electron's Node-only launcher flags.
// The test needs a fresh desktop process and its own isolated profile.
for (const key of Object.keys(process.env)) {
  if (key === "ELECTRON_RUN_AS_NODE" || key.startsWith("VSCODE_"))
    delete process.env[key];
}
await runTests({
  extensionDevelopmentPath: root,
  extensionTestsPath: resolve(root, "dist/integration.cjs"),
  ...(process.env.MIKU_VISUAL_VSCODE || installed
    ? { vscodeExecutablePath: process.env.MIKU_VISUAL_VSCODE || installed }
    : {}),
  extensionTestsEnv: {
    ...process.env,
    MIKU_VISUAL_TEST_ROOT: root,
    MIKU_VISUAL_TEST_SCRATCH: scratch,
  },
  launchArgs: [
    root,
    "--disable-extensions",
    "--skip-welcome",
    "--skip-release-notes",
    "--disable-workspace-trust",
    `--user-data-dir=${scratch}/profile`,
    `--extensions-dir=${scratch}/extensions`,
  ],
});
