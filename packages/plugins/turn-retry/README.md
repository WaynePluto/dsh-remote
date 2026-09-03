# `@dsh-remote/dsh-plugin-turn-retry`

一次网络抖动不该让你重新打一遍字；按了停止之后想接着做，也不该。

## 它解决什么

dsh 自己**已经**会重试失败的模型请求：`@deepseek-ai/dsh-llm-retry` 挂在
`agent/request-error` 瀑布上，默认退避重试 5 次。它不做的是**问你**。预算用完、
或者失败码不在它的可重试名单里时，它调 `next()`，agent 循环抛出 `LlmError`，这一轮以
`turn/end {kind:'error'}` 收尾。从这一刻起 dsh 什么也不提供：会话里多一行红字，
唯一的出路是你再发一条消息。

在手机上、隔着中转、在一次没人盯着的超时之后，这就是一个丢包的全部代价。

**同一个洞也张在「你自己按了停止」后面**：dsh 唯一能唤醒 agent 的入口都要一条
`UserMessage`（§10.5），所以「停一下再接着做」在原版里同样得重新打字。

## 它怎么做

一次失败有两个有用的时刻，本插件都用上了。

### 1. 这一轮还活着的时候 —— 无缝续跑

监听器**先 `await next()` 再决定**，所以自动重试永远有优先发言权，本插件只在它
无话可说时才登场（与 `llm-retry` 的注册顺序无关，见下）。此时 agent 循环还停在
`step()` 里等瀑布返回，于是我们用 dsh 自己的 `ctx.userQuestions` 问一句：

> **模型请求失败** · 自动重试已用尽，是否重新发起这次请求？（TIMEOUT）
> `[重试]` `[放弃]`

点「重试」→ 返回 `{kind:'retry'}` → dsh 在**同一个 turn、同一个 step** 里重跑刚才那次请求
（`packages/core/agent-loop/src/agent.ts:407` 是一句 `continue`）。**不产生多余消息，
不丢已经完成的工具调用，不新开一轮。**

没人应答、没有浏览器连着、或者超过 `askTimeoutMs` → 返回 `undefined`，dsh 的行为和
没装本插件时**一模一样**。

### 2. 这一轮已经结束之后 —— 输入框上方的横幅

时刻 1 只帮得到正在看着页面的人。对其他所有人来说，结局已经durable 地写在 `turn/end` 里，
所以本插件把它折进一个 session projection，浏览器半在 `conversation.input.dock`
（输入框正上方的整宽区域）画一条横幅：

> **上一轮失败了** `[重试]` `[不再提示]`
> ┌────────────────────────────┐
> │ `TIMEOUT：connect ETIMEDOUT …` │ ← 长错误在自己的框里滚，不撑破页面
> └────────────────────────────┘

因为数据来自会话日志的投影，**刷新页面、换设备、手机睡了一小时再回来，横幅都还在**。

**它也管「你自己按了停止」。** dsh 在这两种情况下留下的是同一个洞：唯一的出路是再打一条消息。
所以同一个折叠也认这些结局，只是话说得不一样（按钮写「继续」，给模型的通知也不说「失败」）：

| `turn/end` 的结局 | 横幅 |
|---|---|
| `error` | **上一轮失败了** + 错误详情框 + `[重试]` |
| `aborted{user}` | **上一轮被你停止了** + `[继续]` |
| `aborted{disposed / legacy}`、`interrupted` | **上一轮没有跑完** + `[继续]` |
| `aborted{hook}`（钩子的决定）、`aborted{parent}`（父 agent 收子 agent） | 没有横幅 |
| `completed` / `blocked` / `max-tokens` | 没有横幅 |

这条路径没法复活一个已经关掉的 turn —— dsh 没有这个入口（每种唤醒 agent 的方式都要一条
`UserMessage`，而空消息会让这一轮不发模型请求就结束，`agent.ts:280-286`）。所以它开一个新
turn，带一条极短的 plugin 溯源通知。会话里显示的是一行**折叠的 context 行，不是伪造的用户气泡**
（`packages/client/ui-chat/src/client/conversation-nodes/message.ts:50`）。

### 横幅不许撑破页面

两件事，一件不是文本的错，一件是。

**宽度：dock 条目必须自己声明宽度。** `conversation.input.dock` 那个栈只是一个竖排 flex，
宽度上限在**每张卡自己身上**，不写就铺满整个会话列 —— 比输入框宽 32px、比转录正文宽更多，
**和错误信息有多长毫无关系**。所以横幅照抄 dsh 自己 dock 条目的那一段
（`ui-conversation/.../TodoPanel.module.css:1-21`）：`margin:0 auto` +
`width: calc(100% - 侧留白×2 - dock内缩×4)` + `max-width: calc(卡片上限 - dock内缩×4)`，
变量由 `.root` 继承下来，直接 `var()`（docs/02 §10.7）。

**高度：失败信息是供应商给的字符串**，不是我们能控制的字段：一页 HTML 错误页、一整个被拒的
请求体，都会原样到这里。两道闸：

- **宿主折叠时截断**（`MESSAGE_LIMIT = 2000`）。投影是**推给每个连着的浏览器**的整值帧，
  用 CSS 把它遮起来不等于没传。给模型的重试通知另有更狠的 300 字上限 —— 横幅能滚，
  上下文窗口不能。
- **错误文本有自己的滚动容器**：高度封顶 `7.5em`、`overflow-y:auto`、
  `overscroll-behavior:contain`（在手机上划到底不会带着整个转录一起滚）、`pre-wrap` +
  `overflow-wrap:anywhere`（换行和长 token 都收得住）。按钮在**标题行**，位置不受错误长度影响。
  容器底色是中性半透明灰而不是 `--dsw-alias-bg-layer-*`：浅色主题里那几层是同一个白
  （docs/02 §8.6a）。

## 它刻意不做的事

- **绝不自己重试。** 这里每一次重试都是人按的按钮；自动恢复是 `llm-retry` 的活，本插件
  给它让路而不是和它抢。
- **绝不碰 `always` 重试策略的供应商。** 那个策略的意思是「一直恢复下去」，插一个人类
  决定进去，等于把一次无人值守的恢复变成一次卡死。
- **绝不重发原来的 prompt。** 那条 prompt 已经在日志里了（agent 循环在发起失败的那次请求
  **之前**就 append 了，`agent.ts:291-293`），重发会让模型看到同一条指令两遍。
- **绝不推翻别人已经做出的决定。** 钩子按策略掐掉的一轮、父 agent 收掉的子 agent 轮次，
  都不给「继续」按钮 —— 那不是「没人管的活」，那是有人管过了。

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `ask` | `true` | 是否在失败当场暂停这一轮并询问。关掉就只剩事后横幅 —— 对没人盯着的部署这才是对的形状，因为没人回答的问题会把 turn 一直挂到 `askTimeoutMs`。 |
| `askTimeoutMs` | `600000`（10 分钟） | 暂停的这一轮最多等多久。**刻意有上限**：瀑布正拿着 agent 循环，无上限的等待会把「模型请求失败了」变成「这个会话卡死了」。 |

## 顺序为什么无所谓

本插件和 `llm-retry` 都挂在 `agent/request-error` 上，但**顺序不是正确性前提**：

- 排在 `llm-retry` **之后**（实际情况：它在 bundle 层，本插件走 `--patch`，最后加载）
  → 它用尽预算才调 `next()`，那时才轮到我们问人。
- 万一排在它**之前** → 我们的 `next()` 会把它整个跑完；它要重试就返回 `{kind:'retry'}`，
  我们原样放行，只有它放弃时才轮到问人。

两种顺序下「自动重试优先、问人兜底」都成立。测试里有一条专门锁这个
（`tests/host.spec.ts` 的 *honours a downstream decision without asking anyone*）。

## 两半与接缝

| | |
|---|---|
| 宿主半 | `src/index.ts`，由包根的 `dsh-overlay.yml` 经 `--patch` 插入 |
| 浏览器半 | `src/client/`，dsh 的客户端模块系统按 `dsh.client` + `exports["./client"]` 下发 |
| 状态接缝 | session projection `turnRetry`（宿主算，dsh 自动推给页面，客户端零折叠代码） |
| 动作接缝 | RPC 通道 `/turn-retry`，dsh 给它套上与 `/api` 同款的 Host/Origin 围栏 + 浏览器认证 |

⚠️ **`dist/client.js` 缺失不是降级，而是让 dsh 的 web UI 整个起不来**（FAILED fiber）。
三处产物检查都覆盖了它：`packages/launcher/src/dsh-plugins.ts`、`scripts/local-config.mjs`
的目录扫描、`scripts/pack.mjs` 的两张表。

## 已知代价

- **失败后积压在 inbox 里的消息会跟着一起被消化。** turn 失败走的是 `throw`，dsh 不会自动
  开下一轮，排队的消息就搁在那儿；点重试唤醒 agent 时，它们会和重试通知一起进入同一个 turn。
  这些消息本来就是要跑的，所以这是对的行为，但值得知道。
- **事后重试绕过了 `session.prompt` 的前置校验**（供应商可路由性、图片模态）。纯文本通知
  不涉及图片；供应商不可路由时新 turn 会立刻失败，而那次失败又会被本插件的投影记下来，
  自洽但会多一次往返。
- **升级 dsh 后要复核**：`agent/request-error` 的 payload、`TurnEndReasonMap` 的
  `error` / `aborted` / `interrupted` 分支与 `AgentCancelCause` 的成员、
  `conversation.input.dock` 的槽契约、`ctx.userQuestions.ask` 的形状，
  都是 0.1.2-alpha.4 的样子。事实链记在 `docs/02-dsh-facts.md` §10。
- **投影状态的形状改了要 bump `stateVersion`**（现在是 2）。dsh 会缓存投影行，
  版本对不上才丢弃（`session-projection/src/index.ts:429,459,511`）；不 bump 的话
  旧形状的值会被喂回页面。
