# 技能状态

`@dsh-remote/dsh-plugin-skills-inspector` 在会话头部提供 **技能** tab。
查看当前会话技能目录、来源、加载历史，搜索并展开描述、文件路径。

## 数据口径

- 已加载单独成组，其他技能按项目、全局、内置等来源分组。
- 回放整个会话日志，区分模型 skill 工具加载与用户 /技能名调用，重启不归零。
- 加载失败不计入，尚未配对结果的调用暂计；不保证压缩后的当前上下文仍保留完整正文。
- provider 失败时提示列表可能不完整，不能把失败显示为技能消失。
- 精确文件路径只在展开时查询，避免为列表批量读取全部技能正文。
- 查询需要 live Agent 的 scope 与 cwd；未恢复 Agent 时无法得到完整目录。

## 使用与边界

路径始终可复制。dsh 能打开工作区路径时显示打开按钮，操作发生在运行 dsh 的机器桌面，手机看不到该窗口。
本页只读，不注册技能、来源或工具，不改变模型能力，也不提供加载按钮。
加载技能仍由模型或输入框的 /技能名 发起。

## 维护与验证

源码契约见 [技能与文件](../../../docs/dsh/workspace.md)。

```powershell
pnpm --filter @dsh-remote/dsh-plugin-skills-inspector test
pnpm --filter @dsh-remote/dsh-plugin-skills-inspector typecheck
node scripts/skills-inspector-check.mjs
```

修改插件后必须构建并重启 dsh。
## 停用与补回

本插件是受管 Profile Bundle（默认全开）。在 dsh 插件页停用后：会话里的「技能」tab 消失；技能本身不受影响。launcher 不再自动补回；右键托盘图标选「补回技能状态」，或运行 `node dist/index.js --restore-bundle @dsh-remote/dsh-plugin-skills-inspector` 补回。想让停用被托盘感知，请用 dsh 插件页的开关（直接改 profile patch 层的停用托盘看不见）。
