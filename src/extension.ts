import * as vscode from "vscode";
import { icon } from "./webview/icons";
import { randomBytes } from "node:crypto";
import {
  ViewerSession,
  type Diagnostics,
  type Source,
} from "./backend/session";

const VIEW = "mikuVisual.image";
const sessions = new Map<string, ViewerSession>();
const viewerPanels = new Map<string, vscode.WebviewPanel>();
let lastActiveViewer: string | undefined;

function source(uri: vscode.Uri): Source {
  if (uri.scheme !== "file" && uri.scheme !== "vscode-remote")
    throw new Error("Please open a NIfTI file on the workspace host.");
  return { path: uri.fsPath, name: uri.path.split("/").pop() || "image.nii" };
}

export function activate(context: vscode.ExtensionContext) {
  const updateAddImageContext = () =>
    vscode.commands.executeCommand(
      "setContext",
      "mikuVisual.hasOpenImage",
      [...sessions.values()].some((session) => session.diagnostics.loaded),
    );
  void updateAddImageContext();
  const output = vscode.window.createOutputChannel("Miku Visual3D");
  context.subscriptions.push(output);
  const log = (message: string) =>
    output.appendLine(`[${new Date().toISOString()}] ${message}`);
  log(`Activated on ${vscode.env.remoteName || "local"} workspace host`);
  context.subscriptions.push(
    vscode.commands.registerCommand("mikuVisual.logs", () => output.show()),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "mikuVisual.open",
      async (uri?: vscode.Uri) => {
        try {
          if (!uri)
            [uri] =
              (await vscode.window.showOpenDialog({
                canSelectMany: false,
                filters: { NIfTI: ["nii", "gz"] },
                openLabel: "加载影像",
              })) || [];
          if (!uri) return;
          source(uri);
          await vscode.commands.executeCommand("vscode.openWith", uri, VIEW);
        } catch (error) {
          log(String(error));
          void vscode.window.showErrorMessage(
            `Miku Visual3D: ${String(error)}`,
          );
        }
      },
    ),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "mikuVisual.addOverlay",
      async (uris?: vscode.Uri | vscode.Uri[], selectedUris?: vscode.Uri[]) => {
        const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
        const activeKey =
          input instanceof vscode.TabInputCustom && input.viewType === VIEW
            ? input.uri.toString()
            : undefined;
        const key = [
          activeKey,
          lastActiveViewer,
          ...[...sessions.keys()].reverse(),
        ].find(
          (candidate) =>
            candidate !== undefined &&
            sessions.get(candidate)?.diagnostics.loaded,
        );
        const session = key ? sessions.get(key) : undefined;
        const panel = key ? viewerPanels.get(key) : undefined;
        if (!key || !session || !panel) {
          void vscode.window.showInformationMessage(
            "Please open an image with Miku Visual3D first.",
          );
          return;
        }
        const target = vscode.Uri.parse(key);
        const picked = selectedUris?.length
          ? selectedUris
          : uris
            ? Array.isArray(uris)
              ? uris
              : [uris]
            : undefined;
        for (const uri of picked ?? [])
          if (
            uri.scheme !== target.scheme ||
            uri.authority !== target.authority
          )
            throw new Error("Added images must be on the same workspace host.");
        panel.reveal(panel.viewColumn);
        await session.addOverlay(picked?.map(source));
      },
    ),
  );
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      VIEW,
      {
        openCustomDocument: async (uri: vscode.Uri) => ({ uri, dispose() {} }),
        resolveCustomEditor: async (
          document: vscode.CustomDocument,
          panel: vscode.WebviewPanel,
        ) => {
          const media = vscode.Uri.joinPath(context.extensionUri, "media");
          panel.webview.options = {
            enableScripts: true,
            localResourceRoots: [media],
          };
          const nonce = randomBytes(24).toString("hex");
          const script = panel.webview.asWebviewUri(
            vscode.Uri.joinPath(media, "viewer.js"),
          );
          const style = panel.webview.asWebviewUri(
            vscode.Uri.joinPath(media, "viewer.css"),
          );
          const brand = panel.webview.asWebviewUri(
            vscode.Uri.joinPath(media, "brand.png"),
          );
          const key = document.uri.toString();
          let session: ViewerSession;
          try {
            session = new ViewerSession(source(document.uri), {
              post: (message) => {
                if (message.type === "volume") {
                  if (panel.active) lastActiveViewer = key;
                  void updateAddImageContext();
                }
                void panel.webview.postMessage(message).then((sent) => {
                  if (!sent) log(`Message not delivered: ${message.type}`);
                });
              },
              pickOverlay: async () => {
                const picked =
                  (await vscode.window.showOpenDialog({
                    canSelectMany: true,
                    defaultUri: document.uri,
                    filters: { NIfTI: ["nii", "gz"] },
                    openLabel: "加载影像",
                  })) || [];
                if (!picked.length) return;
                for (const uri of picked)
                  if (
                    uri.scheme !== document.uri.scheme ||
                    uri.authority !== document.uri.authority
                  )
                    throw new Error(
                      "Overlay images must be on the same remote host.",
                    );
                return picked.map(source);
              },
              log,
            });
          } catch (error) {
            void vscode.window.showErrorMessage(String(error));
            return;
          }
          sessions.set(key, session);
          viewerPanels.set(key, panel);
          const viewState = panel.onDidChangeViewState(() => {
            if (panel.active) lastActiveViewer = key;
          });
          if (panel.active) lastActiveViewer = key;
          const receive = panel.webview.onDidReceiveMessage((message) => {
            if (message?.type === "openImage") {
              void vscode.commands.executeCommand("mikuVisual.open");
            } else void session.receive(message);
          });
          const timer = setTimeout(() => {
            if (!session.diagnostics.ready) {
              log("Webview did not start within 15 seconds");
              void vscode.window.showErrorMessage(
                "Miku Visual3D could not start. Run MikuVisual: Show Logs for details.",
              );
            }
          }, 15000);
          panel.onDidDispose(() => {
            clearTimeout(timer);
            receive.dispose();
            viewState.dispose();
            if (sessions.get(key) === session) {
              sessions.delete(key);
              viewerPanels.delete(key);
              if (lastActiveViewer === key) lastActiveViewer = undefined;
            }
            void updateAddImageContext();
            void session
              .dispose()
              .catch((error) => log(`Dispose: ${String(error)}`));
          });
          // Static shell is visible even before JS starts. Assets are ordinary
          // separately bundled files, never serialized functions in inline scripts.
          panel.webview.html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${panel.webview.cspSource}; style-src ${panel.webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${style}"><title>Miku Visual3D</title></head><body>
<div id="app"><header><span class="brand" aria-label="miku Visual3D"><span class="brand-logo"><img class="brand-mark" src="${brand}" width="24" height="24" alt=""><small>miku</small></span><span class="brand-wordmark">Visual3D</span></span><h1 id="title">Opening image…</h1><select id="mainImage" aria-label="主影像" hidden></select><p id="details"></p></header>
<div id="toolbar" role="toolbar" aria-label="影像显示工具">
<button class="icon-button" id="loadImage" title="打开影像 / 分割文件" aria-label="打开影像 / 分割文件">${icon("folder-open")}</button>
<button class="icon-button" id="addImage" title="附加影像 / 分割文件" aria-label="附加影像 / 分割文件" disabled>${icon("file-plus")}</button>
<label class="icon-select" title="视窗布局">${icon("layout")}<select id="viewLayout" aria-label="视窗布局" disabled><option value="quad">四窗</option><option value="slices">三切面</option><optgroup label="单窗"><option value="axial">轴位</option><option value="sagittal">矢状位</option><option value="coronal">冠状位</option><option value="render">三维表面</option></optgroup></select></label>
<button class="icon-button" id="toggleCrosshair" title="显示 / 隐藏十字线" aria-label="显示 / 隐藏十字线" aria-pressed="true" disabled>${icon("crosshair")}</button>
<span class="toolbar-separator" aria-hidden="true"></span>
<label class="toolbar-menu" id="colormapLabel" title="影像颜色映射">${icon("palette")}<select id="colormap" aria-label="影像颜色映射" disabled><option value="gray">Gray</option><option value="gray_r">Gray Inverted</option><option value="bone">Bone</option><option value="copper">Copper</option><option value="viridis">Viridis</option><option value="plasma">Plasma</option><option value="magma">Magma</option><option value="inferno">Inferno</option><option value="cividis">Cividis</option><option value="hot">Hot</option><option value="cool">Cool</option><option value="turbo">Turbo</option><option value="jet">Jet</option><option value="coolwarm">Coolwarm</option></select></label>
<label class="toolbar-menu" id="windowPresetLabel" title="Window preset">${icon("contrast")}<select id="windowPreset" aria-label="Window preset" title="CT presets use HU. For MRI, use Auto or Custom." disabled><option value="auto">Auto</option><option value="custom">Custom</option></select></label><label id="levelLabel">WL <input id="level" aria-label="Window level" type="number" step="any" value="0" disabled></label><label id="windowLabel">WW <input id="window" aria-label="Window width" type="number" min="0.00001" step="any" value="1" disabled></label>
<label id="frameLabel" hidden>帧 <input id="frame" type="range" min="0" value="0"><span id="frameValue"></span></label>
<button class="icon-button" id="resetDisplay" title="重置影像显示" aria-label="重置影像显示" disabled>${icon("rotate-ccw")}</button>
</div>
<div id="surfaceLayers" aria-label="Mask 管理" hidden></div>
<main id="panels" hidden data-layout="quad" aria-label="四窗影像视图"><section id="renderPanel" data-view="render" class="plane render-panel" aria-labelledby="renderTitle"><div class="plane-title"><div class="plane-heading"><h2 id="renderTitle">三维表面</h2><span class="plane-english">3D Surface</span></div><div class="render-actions"><button id="resetSurface" disabled title="恢复初始视角">复位</button></div></div><div id="renderViewport" class="viewport"><p id="renderMessage" class="render-message">Mask required</p></div></section></main><div id="startup">Starting viewer…</div><footer><span id="status" role="status" aria-live="polite">Loading viewer script…</span></footer></div>
<script nonce="${nonce}" src="${script}" defer></script></body></html>`;
        },
      },
      {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: false,
      },
    ),
  );
  // Used by integration tests to verify that the real webview painted, not
  // merely that an editor was opened. Contains counts, never voxel values.
  return {
    getDiagnostics: (): Record<string, Diagnostics> =>
      Object.fromEntries(
        [...sessions].map(([key, session]) => [
          key,
          structuredClone(session.diagnostics),
        ]),
      ),
  };
}

export async function deactivate() {
  await Promise.allSettled([...sessions.values()].map((s) => s.dispose()));
  sessions.clear();
  viewerPanels.clear();
  lastActiveViewer = undefined;
  await vscode.commands.executeCommand(
    "setContext",
    "mikuVisual.hasOpenImage",
    false,
  );
}
