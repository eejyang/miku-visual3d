# 发布更新到 VS Code Marketplace

市场已发布 1.0.0，下一次更新使用 1.0.1 或更高版本。同一版本不能重复发布。

## 一次性配置

在 [Marketplace 发布者管理页面](https://marketplace.visualstudio.com/manage) 打开 `eejyang` 发布者，进入 **Trusted Publishing → Create**，填写：

| 字段 | 值 |
| --- | --- |
| Policy name | Miku Volume releases |
| Repository owner | `eejyang` |
| Repository | `miku-volume` |
| Workflow | `publish.yml` |
| Environment | 留空 |

创建策略后，提交 `.github/workflows/publish.yml`、`package.json`、`package-lock.json` 和 `.vscodeignore` 到仓库。流程通过 GitHub OIDC 取得短期发布凭据，无需配置 `VSCE_PAT` Secret。

如果仓库是私有仓库，官方要求在创建策略后的 48 小时内成功运行首次发布流程。

## 发布下一版

先将准备发布的代码和工作流提交到 `main`，确保工作区干净。当前版本为 1.0.0 时，运行：

```bash
npm version patch
git push origin main
git push origin v1.0.1
```

`npm version patch` 会将版本改为 1.0.1，提交版本变更并创建 `v1.0.1` 标签。以后每次发布递增版本，并推送对应的新标签。

推送版本标签后，在 GitHub 仓库的 **Actions → Publish extension** 查看结果。流程检查标签是否与 `package.json` 的稳定版本一致，依次执行类型检查、测试、构建和打包，然后上传 VSIX 为 Actions artifact，并发布该 VSIX 到市场。

普通分支推送不会发布。只有 `eejyang/miku-volume` 仓库的版本标签推送才会触发发布。流程目前只接受 `1.0.1` 这样的稳定版本，不接受预发布版本。

本地验证不代表 GitHub 或 Marketplace 的实际发布成功；外部权限及市场验证结果需要在首次运行后确认。

参考：[VS Code 官方发布文档](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#publish-with-github-actions-and-trusted-publishing)。
