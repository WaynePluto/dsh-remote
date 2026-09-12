# 精简模式

`@dsh-remote/dsh-plugin-concise-mode` 为 `dsh-remote-web` 提供两个精简 Agent 预设。
新建会话时选择对应预设即可使用，不影响官方 `web` profile。

## 两个预设

| 预设 | 工具调用方式 |
|---|---|
| `concise` | 模型直接调用原生工具 |
| `concise-ptc` | 模型调用 `run_code`，在程序中通过 `tools.*` 使用工具 |

二者都提供项目提示词、文件读写与搜索、技能、当前平台 shell、前台一次性子代理、用户提问、待办和上下文压缩。
它们继承 profile 中的常驻服务与交互终端工具；不包含计划文件、后台任务管理、工作流或网页搜索工具。
普通 shell 与子代理调用不提供后台执行，常驻服务使用 `service_*`。

PTC 的规则、SDK、执行器和 UI 均复用 dsh。工具状态页和执行过程只统计顶层调用，
一次 PTC 程序显示为一次 `run_code`，不展开计算内部子调用次数。

## 装载与限制

本包是 Profile Bundle，放在 `@deepseek-ai/dsh-web-app` 后，不使用普通插件的末尾 overlay。
launcher 只向已有 profile 非破坏性补入缺失的 Bundle，保留用户其他配置。
包内 locator 根据 `import.meta.url` 定位 presets，因此发行包可以移动目录。

`concise-ptc` 的 persona 必须使用 `complete: false`，否则 dsh 生成的 PTC 工具说明会被过滤。
两个预设都使用 `includeRuntimeContext: false`。权限仍由 profile 的固定 YOLO 插件决定。

## 验证

```powershell
pnpm --filter @dsh-remote/dsh-plugin-concise-mode test
pnpm --filter @dsh-remote/dsh-plugin-concise-mode typecheck
pnpm --filter @dsh-remote/dsh-plugin-concise-mode build
node scripts/concise-mode-check.mjs
```

修改后必须重启 dsh。源码依据见 [dsh 核实结论](../../../docs/02-dsh-facts.md)。