# DSH 工作站桌面应用（packages/desktop）

Wails v2.16.0 + Go 原生层的桌面壳：托管自己的 Node launcher 后台（dsh + relay + connector），
内置 WebView 直连本机 relay origin，并常驻托盘。两种运行模式：

- **独立模式（默认）**：双击即用。发现随包载荷（`package/`）与随包/系统 Node 后，
  以 `--desktop` 拉起 launcher，AssetServer 常驻「启动/故障状态页」，后台就绪后对根路径
  一次 HTTP 302 进入真实 relay origin；业务流量不走 AssetServer。托盘提供
  **显示 / 在浏览器中打开 → 工作台、远程管理 / 启动后台 / 停止后台 / 重启后台 / 退出**，悬停提示显示阶段。
  退出（托盘）与崩溃（Windows Job Object KILL_ON_JOB_CLOSE）都会回收自有后台进程树。
- **attach 开发模式（`--attach`）**：附着到已运行的 31809 开发栈（独立 home
  `~/.dsh-station-dev` + `~/.dsh-dev`，可与发行版实例同时运行），不管理它的进程；
  窗口与自绘条标题带「 (dev)」后缀以便和发行版实例区分；无通知管道令牌，
  桌面通知点击定位在开发模式不可用（插件回落普通 toast）。

> **已知安全边界（S1.3 未完成）：** Wails v2.16.0 的 WebView2 默认自动允许网页权限请求；
> 本壳没有原生网络/导航白名单，外站、iframe、WebSocket 和弹窗未隔离。`--relay-url` 只限定
> **初始入口**。现有 relay/dsh 认证和 Host/Origin 检查不变；原生隔离与安全补丁留待 S1.3
> 单独验收，未通过前不作为通过安全验收的发行版。

## 命令

```powershell
pnpm dev:desktop                 # attach 开发模式（需先 pnpm dev 起 31809 栈；启动前探测端口，未就绪则提示后退出）
pnpm dev:desktop -- --selfcheck  # 只检查参数，不创建窗口
pnpm release:desktop:win         # 打 Windows 桌面安装包 + 便携 zip（lite/full）
```

打包脚本 `scripts/pack-desktop.mjs` 只能在目标平台上构建（Wails 依赖系统 WebView/CGO，
不支持交叉编译）；mac/linux 桌面包由 CI 的原生 runner 产出。独立模式自检：

```powershell
dsh-station.exe --selfcheck          # 校验载荷发现（package/ + runtime/node 或系统 Node）
dsh-station.exe --app-dir <目录> --selfcheck   # 开发时校验自定义载荷目录
```

## 桌面 ↔ launcher 控制契约（S2 冻结的最小集）

launcher 以 `--desktop` 运行时（`packages/launcher/src/desktop-link.ts`）：

- 状态：stdout 每行 `@@DSH_STATION {json}`（protocol 1；phase = config/plugins/dsh/relay/
  ready/restarting/stopping/failed，urls.local/admin/dsh，adminReady）。Go 侧镜像在
  `backend.go`，两端由测试锁定（`tests/desktop-link.spec.ts` / `backend_test.go`）。
- 控制：stdin 逐行 JSON 命令，目前只有 `{"type":"stop"}`；重启由桌面壳停止后重新拉起。
- 实例锁：home 下 `launcher.lock`（pid 存活检查），先于插件同步与数据库写入获取。
- 通知管道：桌面壳监听 `127.0.0.1:30810`，首行必须携带共享令牌
  （桌面壳生成 `DSH_STATION_NOTIFY_TOKEN`，经 launcher → dsh 环境传给 notify 插件）；
  无令牌的客户端在握手前被拒绝。插件侧见 `packages/plugins/notify/src/desktop.ts`。

## 自绘标题栏（无边框）

窗口为 Wails `Frameless`，每次顶层导航后经 `OnDomReady` 向页面注入一条 36px 自绘标题栏
（`chromebar.go`）：logo + DSH 工作站 + 页面/应用 + ─ ❐ ✕；主题跟随页面 body 背景色。
脚本带 `location.origin` 守卫，只在 relay 页面注入（独立模式的状态页不注入）。
`转到` 菜单含工作台/远程管理（页面内切换）与「在浏览器中打开」回退；`工作站` 菜单含
重新加载、隐藏到托盘与退出（与状态页「远程管理」、托盘子菜单用词一致）；窗口控制是「业务页零 Go
bindings」的唯一书面例外：`Chrome` 绑定只含 Minimize/ToggleMaximize/Hide/Quit/
OpenExternalHome/OpenExternalAdmin 六个无参方法，`BindingsAllowedOrigins` 仅追加本机
relay origin。Wails v2.16 运行时（`window.go`）只存在于资产服务器主页面，relay 页面上
不可用，因此自绘条经 WebView2 `window.chrome.webview.postMessage('C'+{...})` 直接发送
绑定调用——该消息格式固定于 Wails v2.16.0，升级 Wails 必须复核。独立模式下 relay 端口
若非默认 30809，自绘条的「在浏览器中打开」会静默失效（托盘入口不受影响）：
Go 不复制 launcher 的配置解析，BindingsAllowedOrigins 又无法运行时修改。

任务栏/Alt+Tab 图标经 `WM_SETICON` 使用 exe 资源；`logo.svg` 是
`packaging/dsh-station.svg` 的提交镜像（go:embed 不能引用模块外文件），
`chromebar_test.go` 防止两者漂移。外部浏览器 Cookie 不与内置 WebView 共用。

## 后台状态页（独立模式）

`statuspage.go` 在后台未就绪时渲染自刷新（1.5s）的轻量页面：阶段、原因提示、本机入口与
远程管理链接（仅 loopback 地址）。就绪后对 `/` 发一次 302 进入 relay。后台停止/失败时，
Go 把窗口导航回状态页；用户可从托盘「启动/重启后台」恢复。页面不携带任何凭据。

## 平台

- Windows x64：WebView2 运行库（`wv2runtime.error` 构建标签禁止自动下载安装）；
  缺失时明确报错，不静默回退。
- macOS arm64 / Linux x64：编译依赖系统 WKWebView / WebKitGTK；CI 产物未实机验收
  （S10），不得宣传为已通过。非 Windows 平台暂无常驻托盘（`tray_stub.go`），
  关闭窗口即退出并停止自有后台。
