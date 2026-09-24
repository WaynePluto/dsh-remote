# 桌面预览壳（开发用途）

这是 **Wails v2.16.0 Windows 预览版**，只附着到已有的本机 relay；它不会启动、停止或接管 Node launcher，也不替代现有 Go 托盘启动器或正式绿色包。当前已有独立 Win32 托盘，但没有内置 Node 分发、会话通知或已完成的多机器端口发现。关闭窗口只隐藏到托盘；从窗口或托盘明确退出只结束预览壳，不会停止原有开发栈。

> **不安全，不得作为正式发行版：** Wails v2.16.0 的 WebView2 默认自动允许网页权限请求；本预览版没有原生网络/导航白名单，外站、iframe、WebSocket 和弹窗未隔离。`--relay-url` 只限定**初始入口**，不防止页面随后访问其它站点。不要把这个参数检查当成安全防护；测试期间避免在内置窗口打开不可信外站。现有 relay/dsh 认证和 Host/Origin 检查不变，网页不绑定任何 Go 方法。安全补丁和实机安全验收留待后续单独完成。

## 开发构建（PowerShell 7）

已用固定 Go 1.25.2 和固定 Wails v2.16.0 在 Windows 验证；构建使用 `wv2runtime.error`，不会在缺少 WebView2 时下载或自动安装运行库。

```powershell
# 先在另一个终端运行 pnpm dev，或保留已经运行的 30809 开发栈
pnpm dev:desktop

# 只检查桌面入口，不创建窗口
pnpm dev:desktop -- --selfcheck
```

根脚本先执行 `pnpm desktop:prepare`，把已提交的 `packaging/win-launcher/rsrc_windows_amd64.syso` 复制为被 Git 忽略的桌面构建输入，再执行 `go -C packages/desktop run -tags=production,wv2runtime.error . --attach --relay-url http://127.0.0.1:30809/`。先启动已有开发栈，或使用已经运行中的 `dsh-remote-dev-direct`（30809）；该命令不会再启动、停止或接管一套后台。需要单独构建 exe 时先在仓库根运行 `pnpm desktop:prepare`，再到 `packages/desktop` 执行 `go build -tags 'production,wv2runtime.error'`。本地 exe、Go 测试程序、coverage、Wails `build/bin/` 与复制出的 syso 均不提交。`--attach` 为必需参数，防止误以为预览壳已拥有后台。初始 URL 只接受规范的 `http://127.0.0.1:<端口>/`，例如本机入口的主端口；不要猜成员端口，应从 relay 实际分配结果取得。Wails AssetServer 仅对首个 `/` 返回一次 HTTP 302，让顶层 WebView 进入真实 relay origin；不能使用 JS `location.replace()`，它会把首个 relay 请求标记 `Sec-Fetch-Site: cross-site` 并被 relay 正确拒绝。HTTP/WS 业务均不走 AssetServer。这条首次 302 路径**仅在 Windows WebView2 实测通过**；Wails v2 的 macOS/Linux AssetServer 30x 行为不同，预览模块尚不能在其它平台宣称可用。窗口保留一条紧凑原生菜单栏：**页面 → 主页/管理**在当前桌面窗口内切换，**外部 → 主页/管理**使用系统浏览器回退，**应用 → 隐藏/退出**管理窗口生命周期；所有菜单名为 2 个字。Wails v2 的标准原生菜单无法无侵入合并进 Windows 系统标题栏，自绘无边框窗口不属于这个简单预览壳。托盘菜单为**显示、打开 → 网页/管理、退出**，不提供插件目录或“补回插件”项。外部浏览器 Cookie 不与内置 WebView 共用。

Windows 构建从 `packaging/win-launcher/rsrc_windows_amd64.syso` 复用项目 ICO/DPI 资源；正式图标重新生成时需同步这份资源，避免窗口与托盘退回系统默认程序图标。

后续的后台所有权、托盘、Node 随包分发、通知点击和 macOS/Linux Desktop 验收见根目录 `.agent-plan.md`；这份预览壳尚未通过这些项。根目录正式构建/发行命令目前不包含此 Go module。
