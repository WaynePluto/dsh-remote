# @dsh-remote/dsh-plugin-tools-inspector

在 dsh 会话头部的视图切换栏里加一个「工具」tab：当前会话的 agent 注册了哪些工具、
哪些用过、各用了多少次、有没有失败过。

## 为什么需要它

dsh **没有**把工具表暴露成任何进程外 API（`packages/api/**` 里搜不到 `tools.describe`
之类的方法，见 docs/02 §13.4）。用户在页面上看不到 agent 到底有哪些能力、在用什么。

## ⚠️ dsh 没有工具延迟加载（deferred tool loading）

这是设计这个插件时最容易搞错的一点，完整证据链在 **docs/02 §15.2**：

- pi-coding-agent 有 `getActiveTools()` / `setActiveTools()`，形成「注册集 ⊃ 激活集」
  双层模型，**只增不减**以保住 prompt 缓存前缀。
- **dsh 没有这一层**：`ToolRuntime.view(scope)` 同步算出**唯一一个** `visible` 集合，
  直接喂给系统提示装配。**注册即对模型可见**，不存在「已注册但未激活」的中间态。
- `llm-pi-ai/src/catalog.ts:240` 那个 `deferredToolsMode: 'withhold'` **不是**这回事，
  它是 OpenAI-completions 协议兼容位的 disposition 表项。

所以本插件的状态**只有两档**：`used` / `unused`。页面底部有一行说明把这件事直接告诉用户，
省得别人也去翻源码。

> 将来 dsh 若真的加了 active-set API，加第三档 `'inactive'`：
> `src/shared.ts` 的 `ToolStatus` 加一个成员，`src/client/ToolsView.tsx` 的 `GROUPS`
> 加一行，其余结构不用动。

## 它是只读观察窗口

不注册工具、不调 `tools.restrict()`、不调 `tools.guard()` —— 对 agent 行为**零影响**。
`scripts/tools-inspector-check.mjs` 显式断言这三条：观察工具一旦有了副作用，
它就不再是观察工具了。

技术上可以用 `restrict()` 的 disposer 伪造一个 defer（先 deny，等模型调了某个「目录工具」
再放行），但那是**改变 agent 行为**，不在本插件的职责里。

## 数据来源

| 数据 | 来源 | 备注 |
|---|---|---|
| 注册（=可见）工具表 | `ctx.tools.schemas(agent)` | 只有 name / description / parameters 三个字段 |
| 调用次数 / 失败次数 | **回放会话日志的 `tool/call`** | 覆盖整个会话历史，重启后依然准确 |
| 会话的 scope 与日志 | `ctx.agents.get(sessionId)` | Agent 既是 `ScopeKey`，又带 `session` |

⚠️ **scope 必须传**：agent preset 把工具挂在**每会话的 scope** 下
（dsh `packages/preset/agent-presets/src/mount.ts`）。不传 scope 只能读到全局层 ——
冒烟脚本里那个「没有活 agent 的会话」就只看得到 11 个插件工具，内置工具一个都没有。

### ⚠️⚠️ 计数为什么必须回放日志（第一版在这里错过）

第一版监听 `tools/result` 在内存里累加，并对用户声称「只能统计本次运行」。
**用户重启 dsh 后看到「全部未使用」，当场证伪。** 正确的事实是：

- `tool/call` 是 dsh 的**持久化会话事件**，在 `KNOWN_SESSION_EVENT_TYPES` 里
  （`session/src/known-event-types.ts:66`），且 data **自带 `name`**（`types.ts:306`）。
- `session.snapshotEvents()`（`session/src/index.ts:600`）返回整段日志的不可变快照。

混淆点在 docs/02 §13.2 —— 那条说的是「插件不能 **append** 自己的**新事件类型**」，
与「能不能 **读** dsh 自己的事件」是两码事。**读完全可以。**

配对规则：`tool/result` 只带可选的 `error`，它的 callId 在 `message.source.callId` 与
`message.content[0].toolCallId` **两个等价位置**（`llm/src/message.ts:235,238` 同时写入）。
失败数靠 callId 回填到 call 认领的名字上；配不上对的（日志截断 / fork 前缀只剩一半）
**安全忽略** —— 数不出名字的失败宁可不算，也不要归到错误的工具头上。

## 界面

一屏一列表，不做仪表盘：顶部一条统计带 + 搜索，下面按「已使用（按次数降序）→
已注册未使用（字母序）」分组。状态靠字形（`●` / `○`）不靠颜色 —— 深色主题下颜色容易翻车
（docs/02 §8.6）。点一行展开它的顶层参数。

列顺序：**状态 · 名称 · 调用次数 · 失败数 · 描述**。
次数**紧跟名称**（用户拍板）—— 它是本页最想被看到的一列，排在行尾就得横扫过整条描述
才够得着，而描述是变长的，眼睛落点每行都不一样。次数右对齐 + `tabular-nums`，
个位/十位/百位在同一竖线上收齐；描述放最后吸收剩余宽度，单行截断。

### ⚠️ 中间列必须 `width` 而不是 `minWidth`，且条件内容要占位

一行里除最后一列外，**任何会随内容变宽的盒子都会把它右边的所有列推走**，
于是每行的竖直基准线都不一样。踩过的两个具体形态（用户截图指出）：

- 名称用 `minWidth: 148px` → `cordis_inspect_query` 这类长名字撑开盒子，
  短名字那几行的次数列因此左偏。改成 `width: 196px` + `overflow: visible`：
  盒子宽度与内容无关，超长名字溢出到留白里而**不截断**（工具名截断就没法搜了）。
- 次数用 `minWidth` → 三位数（`252 次`）撑开，描述整列右推。改成 `width: 58px`。
- 失败数是**条件渲染**的 → 只有失败的行多出一格，那几行描述右移。
  改成**常驻固定宽度**（`width: 68px`），无失败时渲染空串并 `aria-hidden`。

一句话：这一行里只有最后的描述列可以是弹性的。

## 座位

`conversation.view`，list 槽，`order: 20`（dsh 自己：chat = 0、trajectory = 10）。
这就是会话头部视图切换栏的来源（dsh `ui-conversation/src/client/apply.ts:121-132`），
范本是 dsh 自己的 `ui-trajectory`。**没有改 dsh 任何源码。**

⚠️ `label` 必须传 **thunk**：传字符串会把注册时的语言钉死，切语言后 tab 文字不变。

## 验证

```powershell
pnpm --filter @dsh-remote/dsh-plugin-tools-inspector test        # 纯函数
pnpm --filter @dsh-remote/dsh-plugin-tools-inspector typecheck   # 两半各一个 program
node scripts/tools-inspector-check.mjs                            # 真机冒烟（31 项）
```

⚠️ **改完插件必须重启 dsh，刷新页面没用**：`dsh-remote-web` profile 里没有挂 hmr 行
（docs/02 §13.7）。
