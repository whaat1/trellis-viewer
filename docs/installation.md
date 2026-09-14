# 安装 Trellis Viewer

当前发布包适用于 **macOS 12 或更新版本、Apple Silicon（M 系列芯片）**。首版主要在 macOS 26 上验证，其他兼容系统欢迎反馈。Intel、Windows 和 Linux 暂未提供经过验证的发行包。

## 下载与安装

1. 在 [GitHub Releases](https://github.com/whaat1/trellis-viewer/releases/latest) 下载 `Trellis-Viewer_0.1.0_aarch64.dmg`。
2. 双击 DMG，将 **Trellis Viewer.app** 拖到 **Applications（应用程序）**。
3. 从“应用程序”打开 Trellis Viewer。安装后可推出磁盘映像。

Release 中的 `Source code (zip)` 是源码，不能当作应用直接运行。

## 首次打开被 macOS 拦截

当前版本采用本地 ad-hoc 签名，**尚未使用 Apple Developer ID 签名或通过 Apple 公证**。这不影响项目开源，但下载后 macOS 可能提示无法验证开发者或无法检查恶意软件。

确认文件来自本仓库、校验值一致后，可以按 [Apple 官方说明](https://support.apple.com/zh-cn/102445) 在尝试打开应用后，前往“系统设置 → 隐私与安全性”，使用针对该应用的“仍要打开”，并按系统提示确认。不同 macOS 版本的文字可能略有不同。

如果系统报告文件损坏、检测到恶意软件，或没有提供允许入口，请先重新下载并核对校验值，附上 macOS 版本和完整提示提交 Issue。不要关闭整台 Mac 的 Gatekeeper 或 SIP。

## 校验下载文件

将 DMG 与 Release 中的 `SHA256SUMS.txt` 放在同一目录，在该目录打开终端运行：

```sh
shasum -a 256 -c SHA256SUMS.txt
```

对应文件应显示 `OK`。校验值用于确认下载文件一致，不等同于 Apple 公证。

## 三步上手

1. 点击“添加本地项目”，选择包含 `.trellis/tasks` 的**项目根目录**。
2. 在任务视图选择父任务或独立任务，展开目录，阅读 PRD、设计和其他 Markdown 文档。
3. 切换“日历”，把右侧任务拖到日期上；拖动色条边缘调整天数，拖回右侧清除排期。

仓库提供 [示例项目](../examples/sample-project)，下载源码后可以导入该目录体验。无需先安装 Trellis CLI；阅读自己的项目时，需要项目已包含 Trellis 任务文件。

## 本地数据与升级

- 导入项目只读；应用不修改任务状态、不归档任务、不执行项目脚本。
- 项目登记、配色与排期保存在 `~/Library/Application Support/local.trellis.viewer/`。
- 阅读区布局等界面偏好由本地 WebView 保存。
- 升级前退出应用，再用新版本替换“应用程序”中的旧版本。应用标识保持不变，已有项目和排期继续使用。
- 卸载应用本体不会自动删除上述设置目录。备份该目录可保留项目登记与排期。

## 当前限制

- Markdown 图片暂显示占位内容，外部链接暂不打开。
- 排期由 Viewer 独立保存，不写回任务文件，也不提供跨设备同步。
- 暂无自动更新；从 Release 下载新版本后手动替换。
- 暂无项目移除入口和任务主视图搜索；日历的待安排列表支持搜索。
