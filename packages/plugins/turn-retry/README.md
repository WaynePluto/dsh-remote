# `@dsh-remote/dsh-plugin-turn-retry`

一次网络抖动不该让你重新打一遍字；按了停止之后想接着做，也不该。

## 它解决什么

dsh 自己已经会自动退避重试失败的模型请求。自动重试最终放弃后，一轮会以
`turn/end {kind:'error'}` 收尾；手动停止则留下 `aborted{user}`。原版 dsh 在这些结局后
都要求用户再发一条消息。

本插件的入口是输入框上方的持久重试栏，显示失败原因与重试或继续操作。

## 工作方式

宿主半把最近一次可恢复的 `turn/end` 折进 session projection `turnRetry`。浏览器半
在 `conversation.input.dock` 渲染：

- `error` →「上一轮失败了」+ `[查看原因]` + `[重试]`；点击「查看原因」在弹窗中阅读错误详情
- `aborted{user}` →「上一轮被你停止了」+ `[继续]`
- `aborted{disposed|legacy}` / `interrupted` →「上一轮没有跑完」+ `[继续]`
- `aborted{hook|parent}` 与正常结局 → 不显示

投影来自会话日志，所以刷新、换设备或稍后回来仍然可见。

## 排队消息保护

`agent.followup()` 会把重试通知追加到 `nextTurn` 队尾。失败后如果已有用户消息排队，
直接调用它会先发送最老的排队消息。

插件因此在宿主侧 fail closed：只要 `nextTurn` 非空，就返回 `pending-input`。
这个分支：

- 不调用 `followup()`，不唤醒 agent；
- 不增删、不重排 inbox；
- 不产生新的 turn 或 `user/message`；
- 保留失败投影，用户处理完队列后仍可再次点击重试。

## 事后重试的消息形状

dsh 没有“不追加 UserMessage 就重新推理”的公开入口。按钮会开一个新 turn，并带一条
plugin 溯源、`form:'notice'` 的短通知；会话里显示为折叠 context 行，不是用户气泡。
原 prompt 已经在日志里，插件不会重复发送。

供应商错误在投影里最多保留 2000 字，给模型的通知最多 300 字。错误详情不常驻占用 dock 高度，
点击「查看原因」后在 dsh 的 `Modal` 中阅读；弹窗尺寸与服务插件日志一致，内容可独立纵向滚动，超长行可横向滚动。
弹窗可拖动、八向调整，右上角关闭按钮旁有全屏开关：全屏时拉满视口并禁止拖动/调整，再次点击恢复原尺寸与位置。
横幅同时复用 dsh 的 composer 宽度轴，不会撑破消息区。

## 两半与接缝

| 部分 | 实现 |
|---|---|
| 宿主半 | `src/index.ts`：projection、inbox guard、RPC |
| 浏览器半 | `src/client/`：输入框上方的重试栏 |
| 状态接缝 | session projection `turnRetry` |
| 动作接缝 | 认证通道 `/turn-retry/retry` |

投影形状仍是 failed/stopped/null，`stateVersion` 保持 2。

## 验证

```powershell
pnpm --filter @dsh-remote/dsh-plugin-turn-retry test
pnpm --filter @dsh-remote/dsh-plugin-turn-retry typecheck
pnpm --filter @dsh-remote/dsh-plugin-turn-retry build
node scripts/turn-retry-check.mjs
```
