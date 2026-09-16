# 安装 Trellis Viewer

当前提供 **macOS 12+ Apple Silicon（M 系列芯片）** 和 **Windows x64** 安装包。Windows 面向 Windows 11 x64；自动构建和安装启动冒烟使用 Windows Server 2022，不代表完整的 Windows 11 人工交互验收。macOS Intel 和 Linux 暂无发行包。

## macOS 下载与安装

1. 在 [GitHub Releases](https://github.com/whaat1/trellis-viewer/releases/latest) 下载 `Trellis-Viewer_0.1.1_aarch64.dmg`。
2. 双击 DMG，将 **Trellis Viewer.app** 拖到 **Applications（应用程序）**。
3. 从“应用程序”打开 Trellis Viewer。安装后可推出磁盘映像。

Release 中的 `Source code (zip)` 是源码，不能当作应用直接运行。

## Windows 下载与安装

1. 在 [GitHub Releases](https://github.com/whaat1/trellis-viewer/releases/latest) 下载 `Trellis-Viewer_0.1.1_x64-setup.exe`。
2. 运行安装程序，按提示安装；默认只为当前用户安装。
3. 从开始菜单打开 Trellis Viewer。缺少 Microsoft WebView2 时，安装程序需要联网安装运行时。

Windows 安装包尚未签名，系统可能显示未知发布者提示。请核对仓库来源与 SHA-256；如果安全软件报告威胁，先停止安装并反馈，不要关闭系统保护。可在 Windows“设置 → 应用”中卸载。

## 首次打开被 macOS 拦截

当前版本采用本地 ad-hoc 签名，**尚未使用 Apple Developer ID 签名或通过 Apple 公证**。这不影响项目开源，但下载后 macOS 可能提示无法验证开发者或无法检查恶意软件。

确认文件来自本仓库、校验值一致后，可以按 [Apple 官方说明](https://support.apple.com/zh-cn/102445) 在尝试打开应用后，前往“系统设置 → 隐私与安全性”，使用针对该应用的“仍要打开”，并按系统提示确认。不同 macOS 版本的文字可能略有不同。

如果系统报告文件损坏、检测到恶意软件，或没有提供允许入口，请先重新下载并核对校验值，附上 macOS 版本和完整提示提交 Issue。不要关闭整台 Mac 的 Gatekeeper 或 SIP。

## 校验下载文件

在 Release 的 `SHA256SUMS.txt` 中找到与你下载文件同名的一行。macOS 在终端计算：

```sh
shasum -a 256 Trellis-Viewer_0.1.1_aarch64.dmg
```

Windows 在 PowerShell 中计算：

```powershell
Get-FileHash .\Trellis-Viewer_0.1.1_x64-setup.exe -Algorithm SHA256
```

计算值应与校验文件一致。校验值用于确认下载文件一致，不等同于开发者签名或 Apple 公证。

## 三步上手

1. 点击“添加本地项目”，选择包含 `.trellis/tasks` 的**项目根目录**。
2. 在任务视图选择父任务或独立任务，展开目录，阅读 PRD、设计和其他 Markdown 文档。
3. 切换“日历”，把右侧任务拖到日期上；拖动色条边缘调整天数，拖回右侧清除排期。

仓库提供 [示例项目](../examples/sample-project)，下载源码后可以导入该目录体验。无需先安装 Trellis CLI；阅读自己的项目时，需要项目已包含 Trellis 任务文件。

## 本地数据与升级

- 导入项目只读；应用不修改任务状态、不归档任务、不执行项目脚本。
- 项目登记、配色与排期：macOS 保存在 `~/Library/Application Support/local.trellis.viewer/`，Windows 保存在 `%APPDATA%\local.trellis.viewer\`。
- 阅读区布局等界面偏好由本地 WebView 保存。
- 升级前退出应用；macOS 替换“应用程序”中的旧版本，Windows 运行新安装包。应用标识保持不变，已有项目和排期继续使用。
- 卸载应用本体不会自动删除上述设置目录。备份该目录可保留项目登记与排期。

## 当前限制

- Markdown 图片暂显示占位内容，外部链接暂不打开。
- 排期由 Viewer 独立保存，不写回任务文件，也不提供跨设备同步。
- 暂无自动更新；从 Release 下载新版本后手动替换。
- 暂无任务主视图搜索；日历的待安排列表支持搜索。

## 项目右键菜单

在左侧项目列表中右键项目，或聚焦项目后按 Shift+F10，可使用：

- **从列表移除**：二次确认后从应用列表移除，不删除电脑上的项目文件或现有聊天。排期和配色保留，重新添加同一路径后恢复。移除当前项目会切换到第一个剩余项目；全部移除后显示添加入口。
- **在 Finder 中显示**：在 Finder 定位项目文件夹；目录已不存在时显示错误。
- **复制路径**：将项目完整本地路径复制到剪贴板。

菜单支持方向键选择、Enter 执行、Escape 关闭。右键非当前项目不会切换当前项目。已移除项目的排期不再展示在日历中；移动目录后以新路径添加不会自动恢复旧身份。

Windows 项目移除、恢复和排序可用；右键菜单中的 Finder 定位和复制路径目前仅在 macOS 可用，Windows 中禁用这两项。
