# @dsh-remote/dsh-plugin-user-message-fork

在普通用户消息的操作栏中增加「从此消息重新开始」按钮。

## 行为

- 只影子覆盖 dsh 的 `conversation.chat.node` / `user` renderer；`steering` 和其他消息类型仍由 dsh 原生 renderer 负责。
- 点击按钮后，从该用户消息所在轮次之前的最后一个已完成 `turn/end` 创建新的子会话。
- 新会话继承前置历史，不继承被点击的用户消息和其后续消息。
- 子会话打开后，被点击的用户消息文本会回填到输入框，用户可以修改后重新发送。
- 原会话不修改、不删除；它仍保留在会话列表中。
- 首轮消息、空文本消息、带附件或未知内容块的消息会保留按钮但禁用，避免创建分支时静默丢失内容。
- 如果前一轮暂时不在当前历史窗口，点击时会先按 dsh 的历史分页接口补齐前缀，再创建分支。
- 标题沿用 dsh 的 fork 约定递增 `(1)` / `(2)`。

插件使用 dsh 已有的 `ctx.sessions.fork()` 和 scoped `conversation.input.setDraft()`，不修改或 fork dsh 源码。

## 开发

```powershell
pnpm --filter @dsh-remote/dsh-plugin-user-message-fork build
pnpm --filter @dsh-remote/dsh-plugin-user-message-fork test
pnpm --filter @dsh-remote/dsh-plugin-user-message-fork typecheck
node scripts/user-message-fork-check.mjs
```

插件改完后必须重启 dsh；`dsh-remote-web` profile 没有 HMR，刷新页面不会重新加载新的浏览器 bundle。

## 分发与管理

本包不作为独立安装项分发，而是 `@dsh-remote/dsh-plugin-conversation-enhancements`（会话增强 Bundle）的组件。停用后，用户消息的「分叉」按钮消失；已创建的子会话不受影响。
可在该 Bundle 详情中单独停用或重新启用本组件；安装、卸载和升级以整个会话增强 Bundle 为单位。
launcher 首次默认安装该 Bundle；后续只升级仍已安装的 Bundle，并保留 Bundle 与组件的停用状态；卸载后不会自动补回。
需要重装时，在 dsh「添加插件」中填写发行包 `plugins/conversation-enhancements` 或开发环境 `.dev/plugins/conversation-enhancements` 的绝对目录。
