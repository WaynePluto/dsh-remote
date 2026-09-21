# `@dsh-remote/dsh-plugin-directory-picker-browse`

这是 dsh-remote 的 Host-only 组合修复插件。dsh Web profile 默认使用
`directory-picker-auto`；在 Windows / macOS 的 loopback 启动环境下它会选择宿主机原生目录对话框，
远程浏览器无法看到这个对话框，因此新会话无法选择工作区。

插件启动时停用 adaptive 行，并通过 dsh Loader 挂载官方的
`@deepseek-ai/dsh-host-directory-picker-browse` 与
`@deepseek-ai/dsh-client-ui-directory-picker-browse` 两半。overlay 只引用本插件自己的相对入口，
不修改 dsh 源码，也不改变 relay 转发协议。

## 停用与补回

本插件是受管 Profile Bundle（默认全开）。在 dsh 插件页停用后：dsh 回到原生目录选择——本机用户桌面弹对话框（人在机器前可用），远程浏览器看不到对话框、无法新建工作区（已有会话不受影响）。launcher 不再自动补回；右键托盘图标选「补回网页目录选择」，或运行 `node dist/index.js --restore-bundle @dsh-remote/dsh-plugin-directory-picker-browse` 补回。想让停用被托盘感知，请用 dsh 插件页的开关（直接改 profile patch 层的停用托盘看不见）。
