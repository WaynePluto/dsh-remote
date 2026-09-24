# 远程设置

`@dsh-station/dsh-plugin-remote-settings` 让已通过 relay 认证的远程浏览器使用完整的 dsh 设置页，
包括模型、凭据和插件配置。组件启用后自动生效，没有单独的设置页面。

它作为远程体验 Bundle 的组件分发（自 `remote-privileged` 拆出的 ownsHost 部分）；connection 的
webServer 注入仍是壳级常驻 overlay，与本包的启停无关。

## 工作方式

dsh 浏览器端通过 `ownsHost` 判断是否可以持久化设置。本插件使用官方的首页注入接口声明
`globalThis.__DSH_TRANSPORT__.ownsHost = true`。

dsh 0.1.7 起 Agent 预设改为 profile YAML 声明，上游不再提供 `settings/openAgentPresetDirectory`
RPC，预设目录打开兼容（0.1.6-alpha.2 时代的 `windowsHide:true` PowerShell opener 补丁）已删除；
上游原生 Windows opener 现与本项目方案一致（直接 `explorer.exe` + 单一 file URI 参数，无 shell）。

本包不注册浏览器设置菜单，也不添加路径复制 UI。
目标机器需要可用的图形桌面；没有原生 opener 时 dsh 仍可能回显路径，打开失败则显示原生错误。
非交互服务环境不能保证出现可见窗口。

### Windows 立即返回与置前（Open In… Explorer 项）

dsh 0.1.7 的原生 opener 等待 Explorer 交接应答（作为「确实打开了」的证明），且不做窗口激活。
本插件在 Windows 上为对话顶部 Open In… 的 Explorer 项保留两个增值：`explorer.exe` 成功创建时
立即返回并 `unref`（网页按钮不等待 Shell 交接），以及异步置前 helper——隐藏的固定 PowerShell
脚本最多 5 秒内按已验证目录匹配可见 Shell 窗口，恢复最小化并通过 `AttachThreadInput`、
`BringWindowToTop` 和 `SetForegroundWindow` 尝试激活。路径以 base64 数据传入固定脚本，
不进入 PowerShell 语法；helper 失败不影响已打开窗口或 RPC 结果，Windows 仍可能拒绝置前；
成功时远程点击会抢占目标机器当前焦点。上游原生打开已可见，是否仅保留置前待实机验收后定。

### 对话顶部「在本地打开」

顶部按钮属于 dsh 的 Open In… 控件；浏览器插件以
`priority:-1` shadow 原生 `conversation.session.header.utilities/open-in-app` 项，完整复用原组件、菜单、
store、inject 和 locale，仅把 `explorer` 的 launch 改到本包的认证 RPC `/remote-settings/open-workspace-directory`。
其它 VS Code、Cursor、JetBrains 等应用仍调用 dsh 原生 open-in-app 路由。

私有 RPC 与原生 Open In… 一样接收浏览器当前会话提供的绝对路径，但只允许已存在目录；通道由 dsh connection
统一执行 Host/Origin 检查和浏览器认证，然后在目标 Windows 机器启动可见 Explorer。失败不会回退到其它实现。

## 分发与管理

本包不作为独立安装项分发，而是 `@dsh-station/dsh-plugin-remote-experience`（远程体验 Bundle）的组件。停用后，经 relay 地址访问的设置页回到 dsh 受限形态；直连 dsh 端口不受影响。
可在该 Bundle 详情中单独停用或重新启用本组件；安装、卸载和升级以整个远程体验 Bundle 为单位。
launcher 首次默认安装该 Bundle；后续只升级仍已安装的 Bundle，并保留 Bundle 与组件的停用状态；卸载后不会自动补回。
需要重装时，在 dsh「添加插件」中填写发行包 `plugins/remote-experience` 或开发环境 `.dev/plugins/remote-experience` 的绝对目录。

## 安全边界

- 不修改 dsh 源码、不改写 Host/Origin，也不绕过 `/api` 的信任校验和浏览器认证。
- 非 loopback 访问必须先通过 relay 登录；本插件不是认证方案。
- `ownsHost` 也会开放调用系统程序打开文件的能力，动作发生在运行 dsh 的机器桌面上，手机看不到该窗口；该标志不是浏览器与目标机器同机的证明。
- 仅加载到 `dsh-station-web`，不修改官方 `web` profile。

## 维护

升级 dsh 时复核 `ClientTransportHooks.ownsHost`、`webserver/index-inject`、原生 Windows opener 行为与
Open In… 槽位（`conversation.session.header.utilities` 的 `open-in-app` 项及 `OpenInAppActionInjected` 形状）；
若上游提供等待即回与窗口激活，应删除本兼容层。
宿主与浏览器构建产物分别为 `dist/index.js`、`dist/client.js`。修改后必须重建、更新安装介质并重启 dsh。

```powershell
pnpm --filter @dsh-station/dsh-plugin-remote-settings test
pnpm --filter @dsh-station/dsh-plugin-remote-settings typecheck
pnpm --filter @dsh-station/dsh-plugin-remote-settings build
```

源码依据见 [dsh 核实结论](../../../docs/02-dsh-facts.md)。