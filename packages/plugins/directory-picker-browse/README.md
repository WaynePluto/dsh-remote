# `@dsh-remote/dsh-plugin-directory-picker-browse`

这是 dsh-remote 的 Host-only 组合修复插件。dsh Web profile 默认使用
`directory-picker-auto`；在 Windows / macOS 的 loopback 启动环境下它会选择宿主机原生目录对话框，
远程浏览器无法看到这个对话框，因此新会话无法选择工作区。

插件启动时停用 adaptive 行，并通过 dsh Loader 挂载官方的
`@deepseek-ai/dsh-host-directory-picker-browse` 与
`@deepseek-ai/dsh-client-ui-directory-picker-browse` 两半。overlay 只引用本插件自己的相对入口，
不修改 dsh 源码，也不改变 relay 转发协议。
