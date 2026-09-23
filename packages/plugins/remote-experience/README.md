# 远程体验 Bundle

`@dsh-remote/dsh-plugin-remote-experience` 是远程体验的整体安装、卸载和升级单位，按固定顺序组合：

1. 远程设置（remote-settings）
2. 浏览器兼容（browser-compat）

本包不包含运行时代码；`cordis.patch.yml` 通过 Bundle 内嵌依赖的相对路径加载固定版本组件，并用 Bundle 选择状态保护 HMR 卸载阶段的瞬时残留行。两个组件都可在 Bundle 详情中单独停用或重新启用，卸载 Bundle 会一起移除它们的装载入口。

网页目录选择需要通过 Bundle 层静态停用 dsh 默认选择器，不能安全地作为可单独停用组件，因此由 `directory-picker-browse` 独立分发。

## 分发与管理

launcher 首次默认安装本 Bundle；后续只升级仍已安装的 Bundle，并保留 Bundle 与组件的停用状态，卸载后不会自动补回。
需要重装时，在 dsh「添加插件」中填写发行包 `plugins/remote-experience` 或开发环境 `.dev/plugins/remote-experience` 的绝对目录。
不要单独安装内部组件；相同稳定插件 ID 被重复装载会产生入口冲突。停用或卸载不会主动清理组件已保存的设置。
