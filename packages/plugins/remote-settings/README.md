# 远程设置

`@dsh-remote/dsh-plugin-remote-settings` 让已通过 relay 认证的远程浏览器使用完整的 dsh 设置页，
包括模型、凭据和插件配置。组件启用后自动生效，没有单独的设置页面。

它作为远程体验 Bundle 的组件分发（自 `remote-privileged` 拆出的 ownsHost 部分）；connection 的
webServer 注入仍是壳级常驻 overlay，与本包的启停无关。

## 工作方式

dsh 浏览器端通过 `ownsHost` 判断是否可以持久化设置。本插件使用官方的首页注入接口声明
`globalThis.__DSH_TRANSPORT__.ownsHost = true`。

自定义 Agent 预设的「打开目录」完全沿用 dsh 原生行为：无论从本机免登录入口
（如 `http://127.0.0.1:30809`）、成员端口还是域名访问，都在**运行 dsh 的目标机器**上打开文件管理器。
pc1 浏览器操作 pc2 时，窗口出现在 pc2 桌面，不会出现在 pc1。复制预设后的自动打开动作也沿用原生行为。

本包不注册浏览器设置菜单，也不添加路径复制 UI；预设的创建、删除、默认选择与权限仍由原生 dsh 处理。
目标机器需要可用的图形桌面；没有原生 opener 时 dsh 仍可能回显路径，打开失败则显示原生错误。
非交互服务环境不能保证出现可见窗口。

### Windows 可见窗口兼容

dsh `0.1.6-alpha.2` 的 Windows opener 以 `windowsHide:true` 启动 PowerShell，再执行 `Invoke-Item`。
在 Windows 11 实测 RPC 返回 `{opened:true}`，但 Shell 窗口为 `Visible:false`。本插件仅在 Windows、宿主声明
支持 nativeOpen 时，于 dsh 完成认证和 Host/Origin 检查后的 `connection/request` 层接管
`settings/openAgentPresetDirectory`：通过 `agentPresets.resolve` 解析并核对 `trust:user`，再以
`windowsHide:false` 直接启动目标机器的 `explorer.exe`。路径使用单一 file URI 参数，不经 shell；浏览器不能提交绝对路径。
目录验证完成后，插件在 `explorer.exe` 成功创建时立即返回并 `unref`，不再等待 Windows Shell 完成交接；
同步启动失败和 spawn 前取消仍返回失败。这样网页按钮无需额外等待数秒，但窗口实际绘制仍由 Windows 异步完成。

Explorer spawn 后还会异步启动隐藏的固定 PowerShell helper：最多 5 秒内按已验证目录匹配可见 Shell 窗口，
恢复最小化状态，并通过 `AttachThreadInput`、`BringWindowToTop` 和 `SetForegroundWindow` 尝试激活。
路径以 base64 数据传入固定脚本，不进入 PowerShell 语法；helper 失败不影响已打开窗口或 RPC 结果。
这是 best-effort，Windows 仍可能拒绝；成功时远程点击会抢占目标机器当前焦点。
非 Windows 或无 opener 时交回 dsh 原生实现。

### 对话顶部「在本地打开」

顶部按钮属于 dsh 的 Open In… 控件；Explorer 项同样通过上述隐藏 PowerShell opener。浏览器插件以
`priority:-1` shadow 原生 `conversation.session.header.utilities/open-in-app` 项，完整复用原组件、菜单、
store、inject 和 locale，仅把 `explorer` 的 launch 改到本包的认证 RPC `/remote-settings/open-workspace-directory`。
其它 VS Code、Cursor、JetBrains 等应用仍调用 dsh 原生 `/open-in-app/open`。

私有 RPC 与原生 Open In… 一样接收浏览器当前会话提供的绝对路径，但只允许已存在目录；通道由 dsh connection
统一执行 Host/Origin 检查和浏览器认证，然后在目标 Windows 机器启动可见 Explorer。失败不会回退到隐藏 opener。

## 分发与管理

本包不作为独立安装项分发，而是 `@dsh-remote/dsh-plugin-remote-experience`（远程体验 Bundle）的组件。停用后，经 relay 地址访问的设置页回到 dsh 受限形态；直连 dsh 端口不受影响。
可在该 Bundle 详情中单独停用或重新启用本组件；安装、卸载和升级以整个远程体验 Bundle 为单位。
launcher 首次默认安装该 Bundle；后续只升级仍已安装的 Bundle，并保留 Bundle 与组件的停用状态；卸载后不会自动补回。
需要重装时，在 dsh「添加插件」中填写发行包 `plugins/remote-experience` 或开发环境 `.dev/plugins/remote-experience` 的绝对目录。

## 安全边界

- 不修改 dsh 源码、不改写 Host/Origin，也不绕过 `/api` 的信任校验和浏览器认证。
- 非 loopback 访问必须先通过 relay 登录；本插件不是认证方案。
- `ownsHost` 也会开放调用系统程序打开文件的能力，动作发生在运行 dsh 的机器桌面上，手机看不到该窗口；该标志不是浏览器与目标机器同机的证明。
- 仅加载到 `dsh-remote-web`，不修改官方 `web` profile。

## 维护

升级 dsh 时复核 `ClientTransportHooks.ownsHost`、`webserver/index-inject`、`connection/request` 与原生 Windows opener；上游修复可见窗口后应删除本兼容层。
宿主与浏览器构建产物分别为 `dist/index.js`、`dist/client.js`。修改后必须重建、更新安装介质并重启 dsh。

```powershell
pnpm --filter @dsh-remote/dsh-plugin-remote-settings test
pnpm --filter @dsh-remote/dsh-plugin-remote-settings typecheck
pnpm --filter @dsh-remote/dsh-plugin-remote-settings build
```

源码依据见 [dsh 核实结论](../../../docs/02-dsh-facts.md)。