import { build, context } from "esbuild";
import { mkdir } from "node:fs/promises";
await mkdir("dist", { recursive: true });
await mkdir("media", { recursive: true });
const jobs = [
  {
    entryPoints: ["src/extension.ts"],
    outfile: "dist/extension.cjs",
    platform: "node",
    format: "cjs",
    external: ["vscode"],
    target: "node18",
  },
  {
    entryPoints: ["src/backend/surface-worker.ts"],
    outfile: "dist/surface-worker.cjs",
    platform: "node",
    format: "cjs",
    target: "node18",
  },
  {
    entryPoints: ["src/webview/main.ts"],
    outfile: "media/viewer.js",
    platform: "browser",
    format: "iife",
    target: "chrome102",
  },
];
for (const job of jobs) {
  const options = {
    ...job,
    bundle: true,
    minify: !process.argv.includes("--watch"),
    sourcemap: process.argv.includes("--watch"),
    logLevel: "info",
  };
  if (process.argv.includes("--watch")) await (await context(options)).watch();
  else await build(options);
}
