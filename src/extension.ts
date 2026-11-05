import * as vscode from "vscode";
import { randomBytes } from "node:crypto";
import {
  ViewerSession,
  type Diagnostics,
  type Source,
} from "./backend/session";

const VIEW = "mikuVisual.image";
const sessions = new Map<string, ViewerSession>();

function source(uri: vscode.Uri): Source {
  if (uri.scheme !== "file" && uri.scheme !== "vscode-remote")
    throw new Error("请打开工作区主机上的 NIfTI 文件。");
  return { path: uri.fsPath, name: uri.path.split("/").pop() || "image.nii" };
}

export function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel("miku visual");
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
          void vscode.window.showErrorMessage(`miku visual: ${String(error)}`);
        }
      },
    ),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "mikuVisual.addOverlay",
      async (uris?: vscode.Uri | vscode.Uri[]) => {
        const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
        if (
          !(input instanceof vscode.TabInputCustom) ||
          input.viewType !== VIEW
        ) {
          void vscode.window.showInformationMessage(
            "请先用 miku visual 打开底图。",
          );
          return;
        }
        const picked = uris ? (Array.isArray(uris) ? uris : [uris]) : undefined;
        for (const uri of picked ?? [])
          if (
            uri.scheme !== input.uri.scheme ||
            uri.authority !== input.uri.authority
          )
            throw new Error("叠加影像必须位于底图所在的工作区主机。");
        await sessions
          .get(input.uri.toString())
          ?.addOverlay(picked?.map(source));
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
                    openLabel: "Add overlay",
                  })) || [];
                if (!picked.length) return;
                for (const uri of picked)
                  if (
                    uri.scheme !== document.uri.scheme ||
                    uri.authority !== document.uri.authority
                  )
                    throw new Error("叠加影像必须位于同一远程主机。");
                return picked.map(source);
              },
              log,
            });
          } catch (error) {
            void vscode.window.showErrorMessage(String(error));
            return;
          }
          sessions.set(key, session);
          const receive = panel.webview.onDidReceiveMessage((message) => {
            if (message?.type === "openImage")
              void vscode.commands.executeCommand("mikuVisual.open");
            else void session.receive(message);
          });
          const timer = setTimeout(() => {
            if (!session.diagnostics.ready) {
              log("Webview did not start within 15 seconds");
              void vscode.window.showErrorMessage(
                "miku visual 界面未能启动。请运行 miku visual: Show Logs 查看原因。",
              );
            }
          }, 15000);
          panel.onDidDispose(() => {
            clearTimeout(timer);
            receive.dispose();
            if (sessions.get(key) === session) sessions.delete(key);
            void session
              .dispose()
              .catch((error) => log(`Dispose: ${String(error)}`));
          });
          // Static shell is visible even before JS starts. Assets are ordinary
          // separately bundled files, never serialized functions in inline scripts.
          panel.webview.html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${panel.webview.cspSource}; style-src ${panel.webview.cspSource}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${style}"><title>miku visual</title></head><body>
<div id="app"><header><span class="brand"><img class="brand-mark" src="${brand}" width="24" height="24" alt="">miku visual<small>医学影像</small></span><h1 id="title">正在打开影像</h1><p id="details">二维切片 · mask 三维表面</p></header>
<div id="toolbar">
<div class="toolbar-row" id="fileControls" role="group" aria-label="影像与叠加控制"><div class="toolbar-actions"><button id="loadImage">加载影像</button><button id="addOverlay" disabled>添加叠加</button><button id="removeOverlay" disabled>移除当前</button></div><label id="overlaySelector" hidden>二维叠加 <select id="activeOverlay" aria-label="选择二维叠加影像"></select></label><label>透明度 <input id="opacity" type="range" min="0" max="1" step="0.01" value="0.5" disabled></label><span id="overlayName"></span></div>
<div class="toolbar-row" id="displayControls" role="group" aria-label="视图与调窗控制" hidden><label>视图 <select id="viewLayout" aria-label="视图布局"><option value="quad">四窗</option><option value="slices">三切面</option><optgroup label="单窗"><option value="axial">轴位</option><option value="sagittal">矢状位</option><option value="coronal">冠状位</option><option value="render">三维表面</option></optgroup></select></label><label id="windowPresetLabel">调窗预设 <select id="windowPreset" title="CT 预设按 HU 应用；MRI 或其他强度数据请使用自动范围或自定义"><option value="auto">自动范围</option><option value="custom">自定义</option></select></label><label id="levelLabel">窗位 <input id="level" type="number" step="any" value="0"></label><label id="windowLabel">窗宽 <input id="window" type="number" min="0.00001" step="any" value="1"></label><label id="frameLabel" hidden>帧 <input id="frame" type="range" min="0" value="0"><span id="frameValue"></span></label></div>
</div>
<details id="surfaceManager" hidden><summary>表面标签 <span id="surfaceLayerCount"></span></summary><div id="surfaceLayers"></div></details>
<main id="panels" hidden data-layout="quad" aria-label="四窗影像视图"><section id="renderPanel" data-view="render" class="plane render-panel" aria-labelledby="renderTitle"><div class="plane-title"><div class="plane-heading"><h2 id="renderTitle">三维表面</h2><span class="plane-english">3D Surface</span><span id="renderCount" class="count"></span></div><div class="render-actions"><button id="resetSurface" disabled title="恢复初始视角">复位</button><button id="rebuildSurface" disabled>重新生成</button></div></div><div id="renderViewport" class="viewport"><p id="renderMessage" class="render-message">添加标签 mask 后显示三维表面</p><div id="renderLegend" aria-label="mask 标签" class="render-legend"></div><span class="render-hint">左键旋转 · 右键平移 · 滚轮缩放</span></div></section></main><div id="startup">正在启动查看器…</div><footer><span id="status" role="status" aria-live="polite">正在加载界面脚本…</span><span>滚轮切片 · 右键拖动调窗 · 点击联动定位</span></footer></div>
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
}
