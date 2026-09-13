# 会话、消息与通知

基线见 [源码依据](../02-dsh-facts.md)。以下路径相对 dsh 仓库根，项目实现明确标注。

## 会话起始目录

出处：`packages/api/session-controller/src/index.ts`、`packages/api/session-controller/src/commands.ts`。

session.create 不带 workspaceId / cwd 时，新会话的 cwd 取 controller 构造时的
defaultCwd，即 dsh 进程的 `process.cwd()`。dsh-remote 的 launcher 不给 dsh 指定 cwd，
因此新会话起始目录就是启动器（systemd 部署里即 unit 的 WorkingDirectory）的 cwd；
服务器部署把 WorkingDirectory 指到可写的工作区目录。

## 失败与重试

出处：`packages/core/agent-loop/src/agent.ts`、`packages/core/agent/src/runtime-types.ts`、
`packages/llm/llm-retry/src/index.ts`、`packages/llm/llm/src/retry-policy.ts`。

模型请求失败时先进入 agent/request-error waterfall；返回 kind:retry 可在同一 turn/step 继续。
llm-retry 默认最多 5 次、初始 500ms、上限 10 秒，可重试码包括 EMPTY_RESPONSE、RATE_LIMIT、SERVER、TIMEOUT、TRANSPORT。
放弃时调用 next；mode:always 会先 next 再无限退避，不能靠下游监听次数判断预算是否耗尽。
最终抛错会写 turn/end，失败后已有 nextTurn 队列可能被搁置。

turn-retry 以持久化 turn/end 为依据：

| 结局 | 动作 |
|---|---|
| error | 重试 |
| aborted:user、disposed、legacy；interrupted | 继续 |
| aborted:hook、parent | 不提供恢复动作 |
| completed、blocked、max-tokens | 正常收尾，不显示重试 |

agent/error 是运行时事件且早于 turn/end，不适合作为持久 UI 状态源。
Agent 的 send/followup/steer/inject 都要求 UserMessage，inject 不唤醒；空消息不会发模型请求。
agents.resume 只恢复活 Agent，不执行新推理。

因此事后重试必须追加一条消息，项目使用 plugin 溯源、form:notice 的短通知，显示为折叠 context 行。
原 prompt 不重发。错误投影限 2000 字，给模型的通知限 300 字，详情在弹窗查看。

followup 会追加 nextTurn 并唤醒，driver 会先消费已有排队消息。
项目在 nextTurn 非空时返回 pending-input，不调用 followup、不改队列、不生成 turn。
nextStep 保持 dsh 原生语义。入口只有输入框上方的重试栏。
队列出处：`packages/core/agent/src/inbox.ts`、`packages/api/session-controller/src/commands.ts`。

## Session Projection

出处：`packages/session/session-projection/src/index.ts`、
`packages/api/session-controller/src/control.ts`、`src/client/sessions/projection-store.ts`。

宿主注册 key、stateVersion、stateSchema、init、apply、wire，纯同步折叠会话事件。
Session Controller 推送所有注册 wire key 的变化，客户端 useProjection 按 key 读取，不需另注册协议。
apply 对无关事件必须返回同一个引用，框架以 Object.is 判断是否推送。
形状改变才调整 stateVersion；类型合并使用 session-projection/types 纯类型出口。

外部插件不能 append 自定义会话事件，原因见 [工具与进程](runtime.md)。

## 执行过程

出处：`packages/client/ui-chat/src/client/conversation-nodes/turn-process.ts`、
`chat/ChatNodeSeat.tsx`、`chat/ChatView.tsx`、`packages/api/session-controller/src/history.ts`。

dsh 发布 turn-process 的窗口、边界和计数，但渲染的 processWindowReady 要求 !historyIncomplete。
页面按 50 条 surface 消息分页，长会话 hasMore:true 时原生折叠会全局关闭。
Turn Location 投影本身不受该门影响，exec-process 复用它并提供自己的分段标题与隐藏规则。

### 分段与统计

- 首段、每条正式消息后的段、过程中的用户消息后的段分别有 Definition。
- 用户消息和正式回答始终在折叠外，段尾回答的 inline reasoning 跟该段折叠。
- 原生 turn-process renderer 以 priority:-1 影子覆盖，其 disclosure 强制 open，避免双重隐藏。
- locations.getTurn 的数组引用反映成员数据变化；可据此按 turn 更新统计。
- 思考来自 assistant-step reasoning blocks，工具完成/失败来自 tool-call 结果，模型重试来自 model-retry。
- 摘要为“思考N次·工具M次·失败K”，无失败省略最后项；结束后隐藏最近动作。
- 结束判断同时看 answerAnchorSeq、Turn closed、后续段头，覆盖无正式回答和 turn 内分段。

### DOM 与滚动

出处：`ChatNodeSeat.tsx`、`ChatView.module.css`、`AssistantMarkdown.tsx`、`ReasoningRow.tsx`。

每行有 data-chat-flow-key、anchor-key、kind、turn。隐藏通过按 flow key 命中的注入样式表，
不写 dsh 自己管理的 hidden 属性，避免与 useSearchableHidden 冲突。

- 整行隐藏用零高度、overflow:hidden、content-visibility:hidden，并 margin:0!important。
  不能 display:none，否则全零 rect 破坏阅读位置二分查找的有序性。
- 行内 data-variant=think 的父 wrapper 则使用 display:none，连正文 flex gap 一并去掉。
- sticky 写在 dsh .flowItem wrapper，不写在插件按钮上；wrapper 的 containing block 是整条消息列。
- 每帧 push=clamp(滚动容器顶+行高-本段最后一行底,0,行高)，top=-push，随段尾等速推出。
- 不能读取标题自身位置反馈偏移；每个标题用独立自定义属性，避免两段同屏互相影响。
- 从祖先实际 overflow 查找滚动容器；不能写死 .scroll，因为布局可把滚动交给祖先。
- `scrollTop` 会被浏览器钳制到 `scrollHeight - clientHeight`；最后一条回复较短时，它的开头在自然底部仍可能低于阅读线。需要严格顶对齐的插件必须临时补足尾部滚动空间，不能只重复调用 `scrollTo`。
- ChatView 的 `onScrollRef` 以当前 scrollTop 与 observedTop 判断读者移动；历史会话首次定位时，原生 smooth scroll 尚未移动的 scroll 事件可能触发 `toBottom`，写回底部并取消动画。ResizeObserver 的跟随也可能覆盖定位；目标 DOM 已存在不代表滚动成功。
- chat-scroll 用 requestAnimationFrame 逐帧推进消息开头定位，按帧复核真实落点；消息行等待上限 3 秒，动画/落点等待上限 1.8 秒，超时不闪线。减少动态效果同样瞬时定位后复核下一帧，读者输入或 sessionId/messageKey 变化取消待定位动作，不需要加载更早的历史。
- chat-scroll 对原生返回底部按钮只做局部 capture：动画先停在 dsh 24px 底部跟随阈值之外，再重放仍连接的原生 click，让 ChatView 自己清理 pending jump/分页锚点并恢复跟随；按钮识别、会话/滚动容器变化或交接失败时不伪造 React 状态。
- 原生返回底部按钮直接内联在 `ChatView.tsx` 的 `!atBottom` 分支，无独立 slot 或滚动 action；`chatScroll.save/read` 只保存阅读位置。`toBottom` 还清理 pending jump/分页锚点、更新 observedTop 并恢复跟随，不能只替换几何写入。接近底部（当前 24px 阈值 + 1px 容差）会使按钮卸载，不能假定 scrollend 后仍能点击它。双向导航增强的待实施方案见 [chat-scroll 开发方案](../chat-scroll-plan.md)。
- 不搬动 React 拥有的 sibling rows 来套内部滚动容器。
- 展开外框用 0.5px border-l2；每个成员和 inline reasoning wrapper 使用不透明 specific-tip 背景。
  sticky 终点测量同一父 wrapper 的真实边界。

### 运行中与节点排序

出处：`packages/client/ui-conversation/src/client/conversation/assembler.ts`、
`packages/client/ui-chat/src/client/chat/TurnTailNodeView.tsx`、`conversation-nodes/common.ts`。

Definition 必须匹配 assistant/chunk 等事件才会在流式期间重建；publication:animation-frame 将更新合并到帧。
审批与用户提问在 composer，turn-tail 为独立行，都不会被过程折叠隐藏。

原生分叉要求 turn-tail 是该 turn 最后一个 Chat Node，组件返回 null 不会从 Location 索引删除节点。
项目段头排序 +0.04，保持 formal < exec-process-step < max-tokens(+0.05) < turn-tail(+0.1)。
真实后续工具或 steering 仍应阻止原生分叉。

用户消息 payload 无 turn/step，Definition 从 context.start.location 读取坐标。
首条 turn-opening user 不额外显示段头；过程中 source.kind:user 的 append 消息才开启新段。
空标题 wrapper 同样零高度、零 margin，保留 rect 顺序。

## 用户消息分叉

出处：`packages/api/session-controller/src/commands.ts`、`src/client/sessions/service.ts`、
`packages/client/ui-conversation/src/client/contract/input.ts`、`packages/client/ui-chat/src/client/chat/MessageItem.tsx`。

fork(sessionId,atSeq) 找 atSeq 后的完整 turn/end 前缀，创建带 parentSession 的子会话，源会话不变。
要从用户消息之前重做，传该 turn 之前最后一个已完成 turn/end 的 seq，不能传用户消息自身 seq。
子会话通过 scoped SessionInput.setDraft 回填文本，标题由 increaseTitle 递增。
没有普通 user-actions 子槽，项目以 user keyed renderer 影子覆盖并保留复制/时间操作。
首轮、空文本、附件或未知内容块不能无损回填时禁用动作；历史不全先分页补齐。

## 任务通知

出处：`packages/core/agent/src/runtime-types.ts`、`packages/core/agent-loop/src/agent.ts`、
`packages/interaction/user-approval/src/types.ts`、`packages/interaction/user-questions/src/types.ts`。

dsh 页面内完成标记不是系统通知。notify 插件观察 agent/status:idle，不能用 turn/end 替代：
一轮结束后 inbox 可能继续运行，idle 下一行也可能同步重新唤醒 driver。
因此延迟 700ms，并再次确认 agent.status。

approval/request 与 user-questions/request 是 waterfall，观察者必须 prepend:true 并原样 next。
被认领的应答者不继续 next，排其后无法观察。事件也不代表卡片实际等待，
用 3 秒计时判断请求是否仍悬挂；asked/decided 审计事件不能用来判断用户正在等待。

会话 cwd 在 session.header，标题来自 title projection，首次完成时标题可能尚未生成。
Windows toast 使用 reminder 场景并有关闭 action；AUMID 不可用时 API 可能成功但不显示，必须保留测试通知按钮。
文案经环境变量传入固定 PowerShell 脚本，XML 用 CreateTextNode，不拼接可执行文本。
这是目标机器的 Windows 桌面通知，不是手机 Web Push。