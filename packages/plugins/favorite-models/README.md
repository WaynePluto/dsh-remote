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

本插件是受管 Profile Bundle，随 profile 的 bundles 数组装载。当前 `dsh-remote-web` profile 没有 HMR；修改插件后必须重新构建并重启 dsh，单纯刷新页面不会加载新产物。

## 停用与补回

本插件是受管 Profile Bundle（默认全开）。在 dsh 插件页停用后：常用模型筛选与收藏入口消失；已收藏列表保留在设置里，聊天模型选择器回到 dsh 原生 /model 目录。launcher 不再自动补回；右键托盘图标选「补回常用模型」，或运行 `node dist/index.js --restore-bundle @dsh-remote/dsh-plugin-favorite-models` 补回。想让停用被托盘感知，请用 dsh 插件页的开关（直接改 profile patch 层的停用托盘看不见）。
