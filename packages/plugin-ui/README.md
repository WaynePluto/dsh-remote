# @dsh-remote/plugin-ui

仅供 dsh-remote 插件的浏览器构建期复用的纯 UI 辅助代码，不是 dsh 插件。

## 边界

- 不提供 overlay、Cordis service、Host 入口或独立运行时状态。
- dialog 几何、pointer 生命周期、设置导航图标、Inspector/dock 样式和共享测试断言由此包提供。
- 消费插件的 client bundle 会把本包内联；React、`react/jsx-runtime`、Cordis、dsh store/slots/primitives 继续使用页面已有的 external 单例。
- 改动后运行 `pnpm --filter @dsh-remote/plugin-ui typecheck`、`pnpm --filter @dsh-remote/plugin-ui build`，再构建使用它的插件。
