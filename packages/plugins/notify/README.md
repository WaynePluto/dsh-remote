# 任务通知

`@dsh-remote/dsh-plugin-notify` 在运行 dsh 的 Windows 机器上发送常驻桌面通知。
通知不会发送到远程浏览器或手机；非 Windows 平台不发送系统通知。

## 使用

在 **设置 → 通知** 中配置两个默认开启的选项：

| 选项 | 时机 |
|---|---|
| 一轮跑完时通知我 | Agent 停下等待输入，700ms 后仍为 idle |
| 有东西在等我回答时也通知我 | 审批或用户提问持续等待 3 秒 |

设置存入 dsh-plugin-notify。通知包含项目、可用的会话标题与完成、失败、停止等结果。
使用“发一条测试通知”确认 Windows 实际显示；没有通知时检查专注助手、系统通知权限和应用注册。

## 限制

- 一次 turn/end 不一定代表整个任务结束，因此使用 Agent idle 而不是逐轮通知。
- 默认 YOLO 自动处理权限请求，仍需人工回答的用户提问可以触发等待通知。
- 新会话第一次完成时标题可能尚未生成。
- Windows 通知 API 返回成功不保证 AUMID 对应通知真的显示，测试按钮不能省略。
- 文案通过环境变量传入固定 PowerShell 脚本，不拼接进可执行代码。

## 维护

通知时序见 [会话与消息](../../../docs/dsh/conversation.md)，导航图标约定见 [插件机制](../../../docs/dsh/plugins.md)。

```powershell
pnpm --filter @dsh-remote/dsh-plugin-notify test
node scripts/notify-check.mjs
```

冒烟会实际尝试弹出通知。修改插件后必须构建并重启 dsh。