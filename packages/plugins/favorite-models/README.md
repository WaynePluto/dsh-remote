# @dsh-remote/dsh-plugin-favorite-models

「常用模型」是 dsh-remote 的正式静态插件：

- 在「设置 → 模型」底部配置 provider + model 形式的收藏项；
- 只以 `priority: -1` 影子覆盖 `conversation.input.model`，聊天输入框按收藏过滤；
- 收藏为空、收藏项全部不在当前目录时回退到完整目录；
- 当前正在使用但未收藏的模型不会被自动切换，触发器仍显示当前选择；
- `/model` 命令不被注册或覆盖，继续使用 dsh 原生完整目录；
- 原生目录加载失败重试、选择失败提示、推理等级、键盘操作、锁定状态和 subagent 可用性由复制的选择器逻辑保留。

设置写入使用 dsh 的 `SettingsScope.mutate`，写入前进行共享校验，写入后回读 `getSnapshot().value` 核对；宿主拒绝时保留页面草稿。

## 构建

```powershell
pnpm --filter @dsh-remote/dsh-plugin-favorite-models typecheck
pnpm --filter @dsh-remote/dsh-plugin-favorite-models test
pnpm --filter @dsh-remote/dsh-plugin-favorite-models build
```

本插件作为模型增强 Bundle 的组件装载。当前 `dsh-remote-web` profile 没有 HMR；修改插件后必须重新构建并重启 dsh，单纯刷新页面不会加载新产物。

## 分发与管理

本包不作为独立安装项分发，而是 `@dsh-remote/dsh-plugin-model-enhancements`（模型增强 Bundle）的组件。停用后，常用模型筛选与收藏入口消失；收藏设置保留，模型选择器回到 dsh 原生目录。
可在该 Bundle 详情中单独停用或重新启用本组件；安装、卸载和升级以整个模型增强 Bundle 为单位。
launcher 首次默认安装该 Bundle；后续只升级仍已安装的 Bundle，并保留 Bundle 与组件的停用状态；卸载后不会自动补回。
需要重装时，在 dsh「添加插件」中填写发行包 `plugins/model-enhancements` 或开发环境 `.dev/plugins/model-enhancements` 的绝对目录。
