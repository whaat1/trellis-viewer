# 做了一个 Trellis 桌面阅读器，把任务、文档和排期放到一个窗口里

最近自己使用 Trellis，项目一多，就经常要在文件夹里切换着看任务、PRD 和设计文档。父任务、子任务和相关材料散在不同目录，想看清整体进展，需要来回翻。

所以做了 **Trellis Viewer**，这次把源码和第一个试用版一起放出来。

它主要做两件事：**集中阅读任务文档**，以及**用月历安排不同项目的计划**。

![任务阅读视图](https://raw.githubusercontent.com/whaat1/trellis-viewer/main/docs/images/tasks.png)

任务视图可以切换本地项目，按状态查看任务，展开父子关系和相关 Markdown 文档。源文件更新后会自动刷新，阅读区的大小也可以自己拖动调整。

![月历排期视图](https://raw.githubusercontent.com/whaat1/trellis-viewer/main/docs/images/calendar.png)

日历里可以把顶层父任务或独立任务拖到某天，拖动色条边缘调整起止日期，也可以拖回右侧取消计划。不同项目用不同颜色区分。

一个设计原则是：**源项目只读。** 配色和排期保存在应用自己的数据目录里，不修改原来的任务状态，也不会给项目安装 Hook 或执行项目脚本。

目前提供 **macOS M 系列芯片版本**，使用 Tauri 2、Rust、React 和 TypeScript，源码采用 MIT 许可证。

这还是第一版，图片预览、外链打开和自动更新还没有做；安装包也尚未经过 Apple 公证，首次打开可能需要按安装说明在系统设置里允许。我把这些限制都写在了 README 和 Release 里。

- GitHub：https://github.com/whaat1/trellis-viewer
- 下载：https://github.com/whaat1/trellis-viewer/releases/latest
- 安装说明：https://github.com/whaat1/trellis-viewer/blob/main/docs/installation.md

也感谢 [trellis-card](https://github.com/czm15053/trellis-card) 带来的灵感。这个项目聚焦任务阅读和排期，是独立的社区工具。

欢迎同样使用 Trellis 的朋友试试。也想听听大家更需要哪一项：任务搜索、文档图片预览，还是其他阅读功能？
