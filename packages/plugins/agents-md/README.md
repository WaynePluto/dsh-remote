# 全局提示词

`@dsh-remote/dsh-plugin-agents-md` 在 **设置 → 全局提示词** 中查看和编辑 `$DSH_HOME/AGENTS.md`。
dsh 会在项目级提示词之前读取这个文件，本插件提供浏览器编辑入口，方便手机远程维护。

## 使用

打开页面，编辑正文并保存。文件不存在时显示空编辑器，首次保存创建文件。
这是一份全局唯一的提示词，保存到 dsh 实际读取的文件，不另存到 settings。

## 限制与安全

- 不改变 dsh 的提示词发现规则，不注册自己的 agent-instructions。
- 大小上限按 UTF-8 字节计算，默认 1 MiB；汉字字节数不能按字符数估算。
- 使用临时文件加 rename 原子保存；写入失败保留草稿并显示错误。
- 宿主与浏览器使用同一 documentFault 校验器。
- 路径显示为 ~/.dsh/AGENTS.md 或 $DSH_HOME/AGENTS.md。

## 维护

load/save 位于 /agents-md/<endpoint>，导航图标通过局部样式增强，升级后要检查上游导航结构。
源码契约见 [工作区](../../../docs/dsh/workspace.md)，共用界面规则见 [插件机制](../../../docs/dsh/plugins.md)。

```powershell
pnpm --filter @dsh-remote/dsh-plugin-agents-md test
node scripts/agents-md-check.mjs
```

冒烟脚本调用 dsh 的 discoverBaselineInstructionFiles，确认真实加载器认领保存的文件。
编辑器保留等宽字体和可伸缩高度，但使用 dsh 的 border-l4、bg-layer-1、brand focus 及 disabled 状态，
不会叠加浏览器默认黑色 focus 轮廓。

修改插件后必须构建并重启 dsh。