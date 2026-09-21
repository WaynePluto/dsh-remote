# @dsh-remote/dsh-plugin-chat-scroll

为 dsh 会话提供统一的滚动导航：每条正式 Agent 消息下方增加一个向上箭头，点击后回到**这条消息的开头**并在落点短暂闪过分界线；dsh 原生右下角的向下箭头返回底部时增加平滑滚动动效。

## 行为

- 按钮位于 dsh 原生的 `conversation.chat.assistant-actions` 槽，与复制、点赞、分支按钮处在同一个操作组中。
- 每条正式 Agent 消息都有自己的按钮；按钮只绑定当前操作组收到的 `messageId`，不局限于最后一条消息。
- 提示文案为「回到消息开头」；英文环境显示 `Back to the start of the message`。
- 通过 Chat snapshot 的 `assistant-step.finalNode.messageId` 找到对应消息行，再用 dsh 的
  `data-chat-flow-key` 找到真实 DOM，不猜 URL、不移动 React 拥有的节点。
- 滚动容器不写死：优先使用 dsh ConversationRoot 的
  `[data-conversation-scroll]`，否则沿祖先查找 ChatView 自己的滚动框。
- 落点沿用 dsh Turn 导航的 24px 阅读线；普通浏览器使用 smooth scroll，开启「减少动态效果」时改为瞬时定位。
- 最后一条回复较短时，浏览器会在自然滚动底部提前钳住目标位置；插件按缺口临时增加尾部滚动空间，下一次用户滚轮、触摸或键盘输入时恢复正常尾部。
- 切换历史会话时如果消息行尚未提交到 DOM，点击动作会等待目标出现，而不是静默失效。
- 首次定位不需要先滚到顶部或点击「加载更早」。插件用 requestAnimationFrame 逐帧推进，若 dsh 保持底部的逻辑介入，会重新测量并继续动画；正常进行的滚动不受干扰。
- 滚轮、触摸、键盘输入或切换会话会取消待完成的定位；定位与校正均有超时上限。
- 返回底部保留 dsh 原生按钮和状态更新：插件先动画到原生底部阈值外，再重放仍连接的原生按钮 click，由 dsh 完成最终归位、清理分页锚点并恢复新消息跟随；无法安全接管时不拦截原生行为。
- 只有确认到达后，分界线才由插件自己的 fixed overlay 闪烁，不向 dsh / React 拥有的消息行写 class 或属性；开启「减少动态效果」也会在下一帧复核落点。

这些接缝已在 dsh 源码中核实：

- `packages/client/ui-chat/src/client/contract/slots.ts`
- `packages/client/ui-chat/src/client/chat/TurnTailNodeView.tsx`
- `packages/client/ui-chat/src/client/chat/ChatNodeSeat.tsx`
- `packages/client/ui-chat/src/client/chat/ChatView.tsx`
- `packages/client/ui-conversation/src/client/skeleton/ConversationRoot.tsx`

## 开发

```powershell
pnpm --filter @dsh-remote/dsh-plugin-chat-scroll build
pnpm --filter @dsh-remote/dsh-plugin-chat-scroll test
pnpm --filter @dsh-remote/dsh-plugin-chat-scroll typecheck
```

浏览器回归：首次打开仍有「加载更早」的历史会话，不滚动、不加载更多，直接点击最后一条回复的「回到消息开头」，确认其开头到达阅读线且有中间滚动位置；再检查短回复、其他回复各自的按钮、切换会话以及「减少动态效果」。手动上滚后点击右下角原生向下箭头，确认有中间滚动位置、最终回到底部，继续生成内容时仍自动跟随；深浅主题与中英文都需验收。

插件改完后必须重启 dsh；当前 `dsh-remote-web` profile 没有 HMR，单纯刷新页面不会重新加载新的浏览器 bundle。

## 停用与补回

本插件是受管 Profile Bundle（默认全开）。在 dsh 插件页停用后：消息开头定位与返回底部按钮消失，回到 dsh 原生滚动行为。launcher 不再自动补回；右键托盘图标选「补回会话滚动导航」，或运行 `node dist/index.js --restore-bundle @dsh-remote/dsh-plugin-chat-scroll` 补回。想让停用被托盘感知，请用 dsh 插件页的开关（直接改 profile patch 层的停用托盘看不见）。
