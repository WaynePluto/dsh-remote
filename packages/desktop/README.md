# 桌面预览壳（开发用途）

这是 **Wails v2.16.0 Windows 预览版**，只附着到已有的本机 relay；它不会启动、停止或接管 Node launcher，也不替代现有 Go 托盘启动器或正式绿色包。当前已有独立 Win32 托盘，但没有内置 Node 分发、会话通知或已完成的多机器端口发现。关闭窗口只隐藏到托盘；从窗口或托盘明确退出只结束预览壳，不会停止原有开发栈。

> **不安全，不得作为正式发行版：** Wails v2.16.0 的 WebView2 默认自动允许网页权限请求；本预览版没有原生网络/导航白名单，外站、iframe、WebSocket 和弹窗未隔离。`--relay-url` 只限定**初始入口**，不防止页面随后访问其它站点。不要把这个参数检查当成安全防护；测试期间避免在内置窗口打开不可信外站。现有 relay/dsh 认证和 Host/Origin 检查不变。安全补丁和实机安全验收留待后续单独完成。

## 开发构建（PowerShell 7）

已用固定 Go 1.25.2 和固定 Wails v2.16.0 在 Windows 验证；构建使用 `wv2runtime.error`，不会在缺少 WebView2 时下载或自动安装运行库。

```powershell
# 先在另一个终端运行 pnpm dev，或保留已经运行的 30809 开发栈
pnpm dev:desktop

# 只检查桌面入口，不创建窗口
pnpm dev:desktop -- --selfcheck
```

根脚本先执行 `pnpm desktop:prepare`，把已提交的 `packaging/win-launcher/rsrc_windows_amd64.syso` 复制为被 Git 忽略的桌面构建输入，再执行 `go -C packages/desktop run -tags=production,wv2runtime.error . --attach --relay-url http://127.0.0.1:30809/`。先启动已有开发栈，或使用已经运行中的 `dsh-remote-dev-direct`（30809）；该命令不会再启动、停止或接管一套后台。需要单独构建 exe 时先在仓库根运行 `pnpm desktop:prepare`，再到 `packages/desktop` 执行 `go build -tags 'production,wv2runtime.error'`。本地 exe、Go 测试程序、coverage、Wails `build/bin/` 与复制出的 syso 均不提交。`--attach` 为必需参数，防止误以为预览壳已拥有后台。初始 URL 只接受规范的 `http://127.0.0.1:<端口>/`，例如本机入口的主端口；不要猜成员端口，应从 relay 实际分配结果取得。Wails AssetServer 仅对首个 `/` 返回一次 HTTP 302，让顶层 WebView 进入真实 relay origin；不能使用 JS `location.replace()`，它会把首个 relay 请求标记 `Sec-Fetch-Site: cross-site` 并被 relay 正确拒绝。HTTP/WS 业务均不走 AssetServer。这条首次 302 路径**仅在 Windows WebView2 实测通过**；Wails v2 的 macOS/Linux AssetServer 30x 行为不同，预览模块尚不能在其它平台宣称可用。

## 自绘标题栏（无边框）

窗口为 Wails `Frameless`，每次顶层导航后经 `OnDomReady` 向页面注入一条 36px 自绘标题栏（`chromebar.go`）：**logo + dsh-remote + 页面/应用 + ─ ❐ ✕** 一行完成，主题取自页面 body 背景色（跟随 dsh 深浅设置）；dsh 外壳是 `html/body/#root` 的 `height:100%` 链，注入脚本用 `body{padding-top:36px; box-sizing:border-box}` 让内容完整缩进条下，无底部裁切。`页面` 菜单含**主页/管理**（页面内 `location.assign` 切换，条随导航自动重建）与分隔线下的**主页（在浏览器中打开）/管理（在浏览器中打开）**（系统浏览器回退）；托盘菜单为**显示、打开 → 网页/管理、退出**。窗口控制是「业务页零 Go bindings」的唯一书面例外：`Chrome` 绑定只含 Minimize/ToggleMaximize/Hide/Quit/OpenExternalHome/OpenExternalAdmin 六个无参方法，`BindingsAllowedOrigins` 仅追加本机 relay origin。Wails v2.16 运行时（`window.go`）只存在于资产服务器主页面（wails.localhost），relay 页面上不可用，因此自绘条经 WebView2 `window.chrome.webview.postMessage('C'+{name,args,callbackID})` 直接发送绑定调用——该消息格式固定于 Wails v2.16.0（铁律固定版本），升级 Wails 必须复核。XSS 风险上限是隐藏/退出窗口或打开既定入口，没有任意 URL、执行或文件能力。任务栏/Alt+Tab 图标经 `WM_SETICON` 使用 exe 资源（无边框窗口没有标题栏图标可显示）。`logo.svg` 是 `packaging/dsh-remote.svg` 的提交镜像（go:embed 不能引用模块外文件），`chromebar_test.go` 防止两者漂移；正式 logo 变更时同步两份。外部浏览器 Cookie 不与内置 WebView 共用。

Windows 构建从 `packaging/win-launcher/rsrc_windows_amd64.syso` 复用项目 ICO/DPI 资源；正式图标重新生成时需同步这份资源，避免窗口与托盘退回系统默认程序图标。

后续的后台所有权、托盘、Node 随包分发、通知点击和 macOS/Linux Desktop 验收见根目录 `.agent-plan.md`；这份预览壳尚未通过这些项。根目录正式构建/发行命令目前不包含此 Go module。
