--------------------
# Miku Volume
轻量的 VS Code NIfTI 医学影像查看插件，支持三切面联动、窗宽窗位调节、多份分割 Mask 对比与三维表面显示。

作者：[eejyang](https://github.com/eejyang) · [GitHub](https://github.com/eejyang/miku-volume) · [问题反馈](https://github.com/eejyang/miku-volume/issues)

在 VS Code 扩展市场搜索 **Miku Volume** 安装，或从 [Releases](https://github.com/eejyang/miku-volume/releases) 下载 `.vsix` 并通过 **Install from VSIX…** 安装，完成后重载窗口。

## 效果展示

![Miku Volume 肺部 CT 与 Mask 四窗查看界面](docs/images/screenshot.png)

## 使用方式

| 操作 | 交互 |
| --- | --- |
| 打开影像 / Mask | 双击 `.nii` / `.nii.gz`，或右键选择 **Open With… → Miku Volume**；也可使用工具栏文件夹图标 |
| 附加影像 / Mask | 工具栏加号文件图标，或右键文件选择 **Miku Volume: Add Image** |
| 切换主影像 | 加载多份影像后，通过标题栏下拉菜单切换 |
| 切片浏览与定位 | 在二维视窗中滚动滚轮或拖动切片滑块；单击影像进行联动定位 |
| 视窗布局 / 十字线 | 通过工具栏布局菜单切换视窗；十字线图标控制二维参考线显隐 |
| 窗宽窗位 | 选择调窗预设、编辑 WL / WW，或在二维视窗中右键拖动 |
| 影像颜色映射 | 通过工具栏 Colormap 菜单切换 |
| 重置二维显示 | 工具栏重置图标恢复默认窗宽窗位及二维视图 |
| 标签选择与定位 | 单击标签选中，双击标签定位至对应结构 |
| Mask 显隐 | 通过眼睛图标显示或隐藏整份 Mask 或单个标签 |
| Mask 颜色 / 不透明度 | 在 Mask 模块中选择配色，或拖动不透明度滑块 |
| 三维表面模式 | 通过 Mask 模块中的实体 / 线框图标切换 |
| 表面重建 / Mask 移除 | 刷新图标重新生成三维表面；删除图标移除当前 Mask |
| 三维视角 | 左键拖动旋转、右键拖动平移、滚轮缩放；“复位”恢复相机 |


原创代码许可：[BSD-2-Clause](LICENSE)；第三方组件及色表许可见 [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES)。