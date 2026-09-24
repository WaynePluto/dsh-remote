# 模型增强 Bundle

`@dsh-station/dsh-plugin-model-enhancements` 是模型增强的整体安装、卸载和升级单位，按固定顺序组合：

1. Copilot 登录（copilot-auth）
2. 模型目录（models-catalog）
3. 模型能力（model-capabilities）
4. 常用模型（favorite-models）

本包不包含运行时代码；`cordis.patch.yml` 通过 Bundle 内嵌依赖的相对路径加载固定版本组件，并用 Bundle 选择状态保护 HMR 卸载阶段的瞬时残留行。Copilot 登录和常用模型可在 Bundle 详情中单独停用或重新启用。

模型目录与模型能力共同参与 `llm-pi-ai` 启动屏障，当前不支持单独关闭这两行；需要停用其中任一功能时，应停用整个模型增强 Bundle。壳级 overlay 固定 `llm-pi-ai` 的屏障依赖，并在本进程启动时未选择模型增强的情况下提供占位屏障，避免运行中切换 Bundle 迫使 `llm-pi-ai` 重启。卸载 Bundle 会一起移除全部组件的装载入口，但不会主动清理已写入的模型、凭据或收藏设置。

## 分发与管理

launcher 首次默认安装本 Bundle；后续只升级仍已安装的 Bundle，并保留 Bundle 与组件的停用状态，卸载后不会自动补回。
需要重装时，在 dsh「添加插件」中填写发行包 `plugins/model-enhancements` 或开发环境 `.dev/plugins/model-enhancements` 的绝对目录。
不要单独安装内部组件；相同稳定插件 ID 被重复装载会产生入口冲突。
