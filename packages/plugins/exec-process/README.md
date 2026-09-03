# @dsh-remote/dsh-plugin-exec-process

在会话流里给**每一段执行过程**一条默认折叠的「执行过程」行。

```
┌─────────────────────────────────────────────────────────────┐
│ 执行过程  思考 12 次 · 工具调用 34 次  失败 2   ● read 进行中  ⌄ │
└─────────────────────────────────────────────────────────────┘
```

点它展开，再点收起。展开后是这一段原本的思考行与工具行；收起时它们整体消失，
只剩上面这一行。**一个圆角细边框**把它和 agent 说的话分开（第一版只有 dsh 那条
下边线，读起来和上一条消息粘在一起）；文字走 dsh 的**次级字号轴**
（`--dsh-content-font-size-secondary`，比正文小一档，跟着设置里的字号走）。

最右边那段说的是「它在干什么」：还在跑就是 **`● pwsh 进行中`**（小圆点会呼吸），
跑完了就是 `最近 pwsh`。两个词的位置不一样是故意的：「进行中」是谓语、跟在名字后面，
「最近」是状语、放在名字前面。并行工具按「还没结束的那个」算，不按「最后开始的那个」算；
名字太长被截断时，**呼吸的小圆点是仍然留在原地的那个状态标识**。

三条贯穿全篇的规则：

- **一段 = 到下一条正式消息为止。** agent 说出来的话不进折叠；正式消息之后，
  再开一条新的「执行过程」。所以一个 turn 有几条正式消息，就有几段。
- **正在跑的轮次也折。** 折叠就是阅读体验本身，等轮次结束才出现等于没有。
  行上的计数实时更新，本身就是进度指示。
- **段尾那条正式消息里的「已思考」也归这一段。** 消息留着，思考跟着折走。

## 为什么需要它

dsh 本来就有这个想法：`ui-chat` 为每个 turn 投影一个 `turn-process` 节点，把正式回答之前的
过程行折进一条细线。但有两件事让它在真实会话里**永远不出现**，还少三个字段：

1. `ChatNodeSeat` 把整套折叠挂在 `!historyIncomplete` 上
   （`packages/client/ui-chat/src/client/chat/ChatNodeSeat.tsx:62-68`），
   而转录窗口只加载**最近 50 条 surface 消息**
   （`packages/api/session-controller/src/client/sessions/session.ts:47,601`）。
   所以会话一超过约五十条消息，`hasMore` 恒为真，**整个视图的折叠被关掉**，
   而且没有任何设置能打开。事实链见 [docs/02-dsh-facts.md](../../../docs/02-dsh-facts.md) §11.2。
2. 它的摘要只数工具调用、助手消息和子 agent，**不数思考次数、不数失败，也从不说最近一次动作**。

## 怎么做的

四处注册，每一处都是能办成这件事的最小接缝：

| # | 注册 | 说明 |
|---|---|---|
| A | `ConversationNodeDefinition`（kind `exec-process`） | 每个 turn 的**第一段**。只提供位置：窗口与边界直接读 dsh 自己发布的 `turn-process` Turn 数据——那份投影**不受** `historyIncomplete` 影响，被关掉的只是它的呈现 |
| B | `ConversationNodeDefinition`（kind `exec-process-step`） | **正式消息之后的每一段**。一个 agent step 恰好一条助手消息，所以按 `turn:step` 建 Context；没说过正式话的 step 出 `visibility: 'hidden'` 而不是撤回节点（撤回已物化的节点会被引擎判错） |
| C | `conversation.chat.node` key `exec-process` / `exec-process-step` | 这一行本身：一个圆角细边框，颜色与字号全部取自 dsh 的令牌与字号轴 |
| D | `conversation.chat.node` key `turn-process`，`priority: -1` | **影子覆盖** dsh 自己的控件 |

D 做两件事：短会话里 dsh 的折叠本来能用，覆盖掉它就不会出现两条控件；同时它把 dsh 的
disclosure **强制常开**，于是 dsh 不再隐藏任何行（包括本插件那一行，它就落在同一个 seq 窗口里），
转录里只剩**一套**折叠机制——本插件的。keyed 槽的 priority 影子覆盖是框架公开支持的能力
（`packages/client/ui-slots/src/index.ts:749-755`，**priority 小的渲染**，同 priority 才抛错），
**与加载先后无关**。

折叠本身是一张按 `data-chat-flow-key` 命中的运行时样式表（`src/client/hidden-rows.ts`），
**不往 dsh 的 DOM 里写任何属性**——`useSearchableHidden` 会 set/remove 同一批 wrapper 的
`hidden`，外部写属性等于和它抢同一个元素。整行隐藏用「零高度 + `content-visibility:hidden`」
而不是 `display:none`，因为 dsh 靠行的 rect 有序性二分查找阅读位置（`ChatView.tsx:93-104`）；
只藏行**内部**那个「已思考」盒子时反过来必须用 `display:none`——它不参与那份 rect 顺序，
而只有 `display:none` 才连 dsh 助手正文那 16px 的 flex 间距一起去掉。

## 展开之后怎么收起来

展开的一段可能有几十行，而唯一能收起它的控件就是那条线本身。所以**展开时那一行会
sticky 到滚动容器顶端**，跟着读者走 —— 但**只跟到自己那段内容为止**。

`position: sticky` 必须写在 **dsh 的行 wrapper** 上，不能写在按钮上：sticky 元素永远出不了
自己的 containing block，而按钮的 containing block 就是那个只有一行高的 `.flowItem`——实测往下滚
900px，按钮的 `top` 是 −900。

同一条规则也带来第二个问题：**containing block 既决定 sticky 从哪开始，也决定它到哪结束**。
wrapper 的 containing block 是**整条消息列**，不是它所概括的那一段，所以浏览器那套
「滚过内容就把 sticky 顶走」在这里永远不会发生 —— 不补的话表头会一路吸到会话结束。
补法是每帧发布一个数字：

```
push = clamp(滚动容器顶 + 行高 − 本段最后一行的底, 0, 行高)
```

表头下面还有内容时这一项是负的、夹到 0，就是普通吸顶；最后一行的底边升过表头自己的底边之后，
`push` 与滚动**等速**增长，表头就以内容的速度滑出容器顶端。实测每滚 1px 推出 1px，
`top` 从 0 连续走到 −32 —— 这正是真正的 containing block 会做的事，所以**不需要过渡动画，也不会跳**。

两条不能破的规则：**公式里绝不能读表头自己的位置**（把 sticky 元素的位置反馈进它自己的偏移量，
会「松开 → 量到自然位置 → 重新吸住」每帧震荡一次）；**每行一个自定义属性**（屏幕上可以同时有两段，
一段已经推出去、另一段还没吸住，共用一个值会把第二段直接顶没）。偏移量写在 `<html>` 上，
由本插件样式表里按 `data-chat-flow-key` 命中 wrapper 的那条规则读取 —— 仍然一个属性都不写进 dsh 的 DOM。

**没有做「内部滚动条」**：这一段展开出来的行是 dsh **自己的兄弟节点**，和这一行同在一个
flex 列里；CSS 的 `overflow` 只裁剪后代，要把它们套进一个容器就得搬动 React 拥有的节点，
而那在 React 卸载/重排那份列表时必然抛错。sticky 是能在不动 DOM 的前提下解决「找不到收起
按钮」的唯一办法。

## 刻意不做的事

- **折叠范围不越过自己那一行。** dsh 的窗口从 `turn/start` 开始，比这一行更早；轮次开头的注入
  上下文行落在那段空隙里，跟着折走就成了「一行凭空消失」。所以起点被夹到本行自己的 anchor：
  「收起」严格等于「这条线以下的东西」。
- **不折正式消息。** 一条带可见文字的助手消息就是「说给人看的话」，哪怕它同时还派了工具。
  「执行过程」只意味着过程。
- **没有宿主行为。** `src/index.ts` 是空插件，它存在只因为 dsh 的客户端模块系统靠 overlay 指向的
  宿主模块往上找到 `package.json` 才会下发浏览器半。**缺 `dist/client.js` 会让 dsh 的 web UI 整个起不来。**

## 外观上的两条硬约束

- **行的背景必须是不透明的 `--dsw-alias-bg-base`**，`:hover` 只能动**边框色和文字色**。
  这一行展开时会 sticky 到滚动容器顶端，而 dsh 的 hover 令牌
  （`--dsw-alias-interactive-bg-hover`）是半透明的 —— 把它画进 background，
  吸顶时下面滚过去的内容就会透出来。
- **字号走 `--dsh-content-font-size-secondary` 而不是写死 13px**：那是 dsh
  「比正文小一档」的次级轴（`gradient-shadow-text.css:56`），每条流式行的标题与摘要都在这条轴上，
  读者在设置里改字号时这一行才会跟着变。

## 已知行为

- **改一次 dsh 设置（例如切换主题）会让浏览器半重新 apply 一次**，折叠状态随之回到默认的
  「全部折起」。折叠状态是模块级的、刻意不持久化——默认折叠本来就是这个行为的设计点，
  所以这里不值得为它加一层存储。生命周期本身是干净的：重新 apply 之后页面上各只有一张
  `<style>`，没有泄漏（实测）。
- **`hasMore` 为假时**（历史被翻到底），dsh 自己的折叠会生效。这时本插件的影子条目会把它的
  disclosure 强制置为 open，实测 dsh 因此 `data-turn-process-hidden` 为 0 —— 一行都不藏，
  转录里仍然只有一套折叠。
- **运行中折叠不会挡住审批。** dsh 的审批卡与 `userQuestions` 都渲染在 `conversation.composer`
  （输入框那一片），不在消息流里，折叠碰不到它们。

## 唯一的 DOM 耦合

两个属性，都退化得干净：

- `data-chat-flow-key`（`ChatNodeSeat.tsx:129`）——改名了这一行照常渲染，只是**不再隐藏任何东西**。
- `data-variant="think"`（`ReasoningRow.tsx:33`）——改名了只是「已思考」盒子不再跟着折。

升级 dsh 后跑一次冒烟：

```powershell
node scripts/exec-process-check.mjs
```

它会先把**构建产物**放进 vm 跑一遍 `apply()`（确认两个座位、priority、以及每个副作用都可撤销），
再起一个真 dsh 确认 bundle 被下发。

## 开发

```powershell
pnpm --filter @dsh-remote/dsh-plugin-exec-process build      # 两半
pnpm --filter @dsh-remote/dsh-plugin-exec-process test       # 144 项
pnpm --filter @dsh-remote/dsh-plugin-exec-process typecheck  # 宿主程序 + 浏览器程序各一次
```
