# `@dsh-station/dsh-plugin-directory-picker-browse`

这是 dsh-station 的 Host-only 组合修复插件。dsh Web profile 默认使用
`directory-picker-auto`；在 Windows / macOS 的 loopback 启动环境下它会选择宿主机原生目录对话框，
远程浏览器无法看到这个对话框，因此新会话无法选择工作区。

Bundle 层用同一个 `directory-picker` 行替换 adaptive 实现，插件再通过 dsh Loader 挂载官方的
`@deepseek-ai/dsh-host-directory-picker-browse` 与
`@deepseek-ai/dsh-client-ui-directory-picker-browse` 两半。停用整个 Bundle 后覆盖消失，原生实现恢复；
它不修改 dsh 源码，也不改变 relay 转发协议。

## 分发与管理

本插件作为独立 Bundle 分发，可单独停用、卸载和升级。停用后，dsh 回到原生目录选择：本机桌面会弹出对话框，远程浏览器看不到该对话框，因而无法新建工作区；已有会话不受影响。
launcher 首次默认安装本插件；后续只升级仍已安装的插件并保留停用状态，卸载后不会自动补回。
需要重装时，在 dsh「添加插件」中填写发行包 `plugins/directory-picker-browse` 或开发环境 `.dev/plugins/directory-picker-browse` 的绝对目录。
