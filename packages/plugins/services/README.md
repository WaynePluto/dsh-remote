# 常驻服务

`@dsh-remote/dsh-plugin-services` 管理有名字的长期命令，例如前后端开发服务器。
服务独立于会话和 dsh 进程，注册表与日志保存在项目目录，便于重启后继续查看和停止。

## 使用

让模型创建服务，输入框上方会出现“常驻服务”面板。展开后查看运行状态、日志或停止服务。
没有运行中的服务时面板不显示，已停止服务的日志仍可通过工具读取。

| 模型工具 | 用途 |
|---|---|
| service_start | 启动具名命令，支持端口、日志正则或定时就绪探测 |
| service_list | 列出服务并与操作系统实际进程核对 |
| service_logs | 读取日志尾部，包括已停止服务 |
| service_stop | 停止整个服务进程树 |
| service_restart | 用保存的启动命令重启 |

普通短命令使用 pwsh/bash；常驻服务不使用 dsh 的会话级 jobs。

## 数据与限制

- 注册表：<项目>/.agents/services.json；日志：<项目>/.agents/logs/<name>.log。
- 日志在独立弹窗显示，面板没有创建服务的按钮。
- 用 pid 加创建时间确认进程身份；pid 已复用时不杀，身份不明时拒绝自动停止。
- 页面隐藏时停止轮询，运行状态每 5 秒刷新，时长按宿主快照加本地流逝计算。
- 注册表原子写入保证不会读到半个 JSON，但不等于跨会话并发写入的事务锁。

## 安全

服务通过 spawn 在沙箱外执行。start/restart 读取调用方的沙箱模式：
danger-full-access 无需额外批准，受限模式只接受 allowed-once，缺少会话或批准能力则拒绝。
未挂沙箱的组合体没有受限模式。approvalInConfinedSandbox 默认 true，关闭意味着接受服务逃出沙箱。
默认固定 YOLO 下是全权限执行，请阅读 [安全说明](../../../docs/04-security.md)。

## 维护与验证

Windows 使用 L1/L2 两级 Node 启动器，注册表记录 L2；不能只靠 detached:true 抵抗 taskkill /T。
PowerShell 使用 NoProfile、NonInteractive 和 UTF-8 前缀。详细契约见 [工具与进程](../../../docs/dsh/runtime.md)。

```powershell
pnpm --filter @dsh-remote/dsh-plugin-services test
node scripts/services-check.mjs
```

live 测试验证真实进程存活、日志和停止；仅 mock 测试不能证明这些操作系统性质。
修改插件后必须构建并重启 dsh，再确认既有服务能被认领。