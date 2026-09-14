# 开发与构建

需要 Rust、Node.js 20.19+、Python 3 和 pnpm 10。macOS 构建还需要 Apple Silicon Mac 与 Xcode Command Line Tools；Windows 构建需要 Windows 11 x64、Microsoft C++ Build Tools 和 WebView2。

```sh
pnpm install --frozen-lockfile
pnpm tauri dev
```

## 检查

```sh
pnpm lint
pnpm typecheck
pnpm test
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo test --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
pnpm build
```

Rust IPC 类型发生变化后，运行 `cargo run --manifest-path src-tauri/Cargo.toml --bin export-contracts` 并提交生成的 TypeScript 契约。

## 发布 Windows 安装包

```powershell
pnpm release:windows
```

该命令生成未签名的 Windows 11 x64 NSIS 安装包，默认按当前用户安装；缺少 WebView2 时安装器会联网补装。产物位于 `src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/`。当前流程仅用于本机验证，不上传文件。

## 发布 DMG

```sh
pnpm release:mac
```

脚本先构建 `.app`，在临时副本中排除开发用 CLI、附带许可证通知并完成 ad-hoc 签名，再使用 macOS `hdiutil` 制作包含 Applications 入口的 DMG。产物和校验值位于 `release/<版本>/`。脚本遇到同名发行包会停止，避免悄悄覆盖已发布的版本；每个正式更新应同步修改 package.json、Cargo.toml 与 tauri.conf.json 中的版本。

制作镜像需要正常的 macOS 磁盘镜像服务；受限制的沙箱环境可能禁止挂载或创建镜像。脚本不申请 Apple 证书、不执行公证，也不上传文件。公开发布使用经过验证的 `release:mac` 产物。

图标源文件为 `public/brand/icon.svg`。使用 `pnpm tauri icon public/brand/icon.svg --output <临时目录>` 重新生成 ICNS/PNG 后，将 macOS 所需文件同步到 `src-tauri/icons/` 和 `public/brand/icon.png`。

## 代码结构

- `src/app`：应用布局与项目导航。
- `src/state`：任务索引、选择与排期状态。
- `src/features/documents`：Markdown Worker、清理与虚拟阅读。
- `src/features/calendar`：FullCalendar 月历与日期适配。
- `src-tauri/src`：只读项目索引、文件监听与应用自己的设置。
- `examples/sample-project`：可直接导入的合成示例项目。

浏览器演示需显式访问 `?demo=1`；它使用合成数据，不能代替原生应用的文件读取或性能验证。

## 性能工具

保留了 `scripts/fixtures.py`、`native_perf.py` 等复现工具。样本必须由 fixtures.py 创建；生成器拒绝覆盖未标记的目录，压力写入只能针对它自己生成的样本。普通单元测试会验证完整 Markdown Worker 语料；解析时间不代表原生窗口的完整交互延迟。

当前版本没有完成正式的大规模原生交互性能验收，不作固定帧率、P95 延迟或空闲资源占用承诺。公开试用不以重跑长性能矩阵为前提。
