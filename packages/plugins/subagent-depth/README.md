# @dsh-remote/dsh-plugin-subagent-depth

在 **设置 → 插件 → 插件配置** 中增加一张「子代理深度」卡片，作为 dsh 已加载子代理工具的全局深度上限。

## 作用

- `0`：禁止模型创建子代理
- `1`：只允许直接子代理
- `2`：允许子代理再委派一层
- `3`：dsh 当前默认值

设置是实时的，但只影响下一次创建子代理。已经运行的子代理不会被终止；当下一次委派会超过上限时，工具调用会返回拒绝结果。

本插件使用 `dsh-plugin-subagent-depth` settings 命名空间。浏览器半注册到 dsh Plugins 页的 `plugins.item` list slot（0.1.6 前为 `settings.plugin.item` keyed slot），因此不会新增设置导航页面，也不覆盖 dsh 自带的模型选择卡片。

## 当前限制

dsh 发布的 `tool-subagent` 实例默认最多允许三层，本插件提供 `0–3` 的全局默认配置。实际深度仍受 Agent preset 中的 `maxDepth` 限制。

guard 按模型工具名 `subagent` / `subagent_*` 生效，覆盖标准 preset 的 `subagent`、`subagent_fork` 以及可选的 Codex / Claude Code 工具实例。

## 验证

```powershell
pnpm --filter @dsh-remote/dsh-plugin-subagent-depth test
pnpm --filter @dsh-remote/dsh-plugin-subagent-depth typecheck
pnpm --filter @dsh-remote/dsh-plugin-subagent-depth build
```

### 浏览器验收

构建后重启 dsh，再刷新页面（此 profile 没有 HMR）。在深色、浅色主题分别检查：

- 展开「子代理深度」与内置「终端」卡片，对比字段宽度、高度、圆角、文字与背景。
- 点击下拉框或用 Tab 聚焦：细边框切换为主题品牌色，不叠加默认粗轮廓；菜单展开时保持边框色。
- 选项弹层复用 dsh `Menu`，与「通用设置 → 语言」菜单使用同一浅色 hover、圆角、阴影与右侧选中勾号。
  选中项未悬停时不常驻深色背景，选项仍为 `0–3`。
- Enter/Space 或方向键打开菜单，方向键/Home/End 移动焦点，Enter/Space 确认；Escape 只关闭菜单，
  焦点回到字段，父设置窗口保留。Tab 关闭并继续表单导航；点击外部关闭不抢焦点。
- 选项位于 portal 中：滚动设置面板后仍紧贴触发器，不被卡片裁剪；折叠卡片时菜单一起消失。
- 修改后「放弃修改」恢复已存值；保存后刷新仍为新值。只读/保存中禁用字段，使用 tertiary 文字。

触发器样式参照 dsh `packages/client/ui-settings-plugins/src/client/fields.module.css`，
弹层参照 `packages/client/locale/src/client/LanguageRow.tsx` 与 `ui-primitives/src/Menu.tsx`。
`tests/styles.spec.ts` 只防止样式契约退化，不能代替真实浏览器的主题与交互验收。

## 停用与补回

本插件是受管 Profile Bundle（默认全开）。在 dsh 插件页停用后：子代理深度上限设置消失，回到 dsh 发布的默认 maxDepth=3。launcher 不再自动补回；右键托盘图标选「补回子代理深度」，或运行 `node dist/index.js --restore-bundle @dsh-remote/dsh-plugin-subagent-depth` 补回。想让停用被托盘感知，请用 dsh 插件页的开关（直接改 profile patch 层的停用托盘看不见）。
