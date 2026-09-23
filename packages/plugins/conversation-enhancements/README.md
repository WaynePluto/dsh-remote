# 会话增强 Bundle

`@dsh-remote/dsh-plugin-conversation-enhancements` 是会话增强的整体安装、卸载和升级单位，按固定顺序组合：

1. 失败重试（turn-retry）
2. 执行过程（exec-process）
3. 聊天滚动（chat-scroll）
4. 用户消息分叉（user-message-fork）
5. 通知（notify）

本包不包含运行时代码；`cordis.patch.yml` 通过 Bundle 内嵌依赖的相对路径加载固定版本组件，并用 Bundle 选择状态保护 HMR 卸载阶段的瞬时残留行。每个组件都可在 Bundle 详情中单独停用或重新启用，卸载 Bundle 会一起移除全部组件的装载入口。

## 分发与管理

launcher 首次默认安装本 Bundle；后续只升级仍已安装的 Bundle，并保留 Bundle 与组件的停用状态，卸载后不会自动补回。
需要重装时，在 dsh「添加插件」中填写发行包 `plugins/conversation-enhancements` 或开发环境 `.dev/plugins/conversation-enhancements` 的绝对目录。
不要单独安装内部组件；相同稳定插件 ID 被重复装载会产生入口冲突。停用或卸载不会主动清理组件已保存的设置或会话数据。
