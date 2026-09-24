# 工具状态

`@dsh-station/dsh-plugin-tools-inspector` 在会话头部提供 **工具** tab。
查看当前 Agent 可见的工具、使用次数、失败次数，并可搜索、展开描述与参数。

## 数据口径

- 可见工具来自 ctx.tools.schemas(agent)，包含当前会话预设与插件工具。
- 调用与失败次数回放整个会话日志，dsh 重启后不会归零。
- 状态只有已使用、未使用两档；dsh 没有独立的“已注册但未激活”工具层。
- PTC 按顶层 tool/call 统计，一次程序记为一次 run_code，不展开累计内部 SDK 调用。
- 结果无法与 callId 配对时安全忽略，不把失败归给其他工具。
- 没有 live Agent 时无法给出完整的会话工具表。

## 只读边界

本页不注册工具、不 restrict、不 guard，不改变模型能力。
已使用工具按次数排列，未使用工具按名称排列；点击条目只展开信息。

## 维护与验证

统计与 scope 契约见 [工具与进程](../../../docs/dsh/runtime.md)，
tab、主题与表格规则见 [插件机制](../../../docs/dsh/plugins.md)。

```powershell
pnpm --filter @dsh-station/dsh-plugin-tools-inspector test
pnpm --filter @dsh-station/dsh-plugin-tools-inspector typecheck
node scripts/tools-inspector-check.mjs
```

修改插件后必须构建并重启 dsh。

## 分发与管理

本包不作为独立安装项分发，而是 `@dsh-station/dsh-plugin-development-tools`（开发工具 Bundle）的组件。停用后，会话里的「工具」页签消失。
可在该 Bundle 详情中单独停用或重新启用本组件；安装、卸载和升级以整个开发工具 Bundle 为单位。
launcher 首次默认安装该 Bundle；后续只升级仍已安装的 Bundle，并保留 Bundle 与组件的停用状态；卸载后不会自动补回。
需要重装时，在 dsh「添加插件」中填写发行包 `plugins/development-tools` 或开发环境 `.dev/plugins/development-tools` 的绝对目录。
