# @dsh-remote/dsh-plugin-subagent-depth

在 dsh **插件 → `@dsh-remote/dsh-plugin-subagent-depth` Bundle 详情页**直接提供「最大委派深度」配置字段，作为已加载子代理工具的全局深度上限。表单使用 Bundle 页面已有的标题与说明，不再额外嵌套可折叠卡片。

## 作用

- `0`：禁止模型创建子代理
- `1`：只允许直接子代理
- `2`：允许子代理再委派一层
- `3`：dsh 当前默认值

设置是实时的，但只影响下一次创建子代理。已经运行的子代理不会被终止；当下一次委派会超过上限时，工具调用会返回拒绝结果。

dsh 0.1.7 起深度上限存在本插件行的 composition Config（entry id `subagent-depth`）里，经 Loader 热更新免重启生效。浏览器半以包名 `@dsh-remote/dsh-plugin-subagent-depth` 为 key 注册到 `plugins.bundle.config`，所以表单只出现在本 Bundle 的详情页，不会再作为 `plugins.item` 官方卡片出现。

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

- 从插件列表打开本 Bundle，配置字段直接显示在详情页；页面内没有第二张卡片、重复标题或外层折叠箭头。
- 对比已安装 dsh 的其他插件配置字段：标签、说明文字、字段间距和操作按钮语义一致。
- 点击下拉框或用 Tab 聚焦：细边框切换为主题品牌色，不叠加默认粗轮廓；菜单展开时保持边框色。
- 选项弹层复用 dsh `Menu`，与「通用设置 → 语言」菜单使用同一浅色 hover、圆角、阴影与右侧选中勾号。选中项未悬停时不常驻深色背景，选项仍为 `0–3`。
- Enter/Space 或方向键打开菜单，方向键/Home/End 移动焦点，Enter/Space 确认；Escape 只关闭菜单，焦点回到字段，插件页保留。Tab 关闭并继续表单导航；点击外部关闭不抢焦点。
- 选项位于 portal 中：滚动插件详情页后仍紧贴触发器，不被详情区裁剪。
- 修改后「放弃修改」恢复已存值；保存后刷新仍为新值。只读/保存中禁用字段，使用 tertiary 文字；写入被宿主拒绝（mutate 返回 false）或传输失败时保留草稿并就地提示。

触发器和字段排版参照 dsh `packages/client/ui-settings-plugins/src/client/fields.module.css`，表单操作区参照同包 `PluginConfigForm.module.css`，弹层参照 `packages/client/locale/src/client/LanguageRow.tsx` 与 `ui-primitives/src/Menu.tsx`。`tests/styles.spec.ts` 只防止样式与槽位契约退化，不能代替真实浏览器的主题与交互验收。

## 分发与管理

本插件作为独立 Bundle 分发，可单独停用、卸载和升级。停用后，子代理深度上限设置消失，回到 dsh 发布的默认 `maxDepth=3`。
launcher 首次默认安装本插件；后续只升级仍已安装的插件并保留停用状态，卸载后不会自动补回。
需要重装时，在 dsh「添加插件」中填写发行包 `plugins/subagent-depth` 或开发环境 `.dev/plugins/subagent-depth` 的绝对目录。
