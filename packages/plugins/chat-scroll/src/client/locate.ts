/** dsh 用于助手消息的 Chat Node kind。 */
export const ASSISTANT_FLOW_KIND = 'assistant-step'

/** 阅读线距 scrollport 顶部的默认 inset。 */
export const READING_LINE_INSET_PX = 24

/** 滚动定位的最长稳定时间；超时不能闪出虚假的到达效果。 */
export const MAX_LANDING_WAIT_MS = 1_800

/** 等待会话切换 DOM commit 的最长时间，超时后放弃。 */
export const MAX_TARGET_WAIT_MS = 3_000

/** 查找一个已完成助手消息所需的 Chat snapshot 最小子集。 */
export interface ChatOrderSnapshot {
  readonly order: readonly string[]
  readonly nodes: {
    get(key: string): {
      readonly kind?: string
      readonly data?: unknown
    } | undefined
  }
}

/** 从一个已完成的助手 Chat Node 读取持久消息 id。 */
function finalizedAssistantMessageId(
  node: ReturnType<ChatOrderSnapshot['nodes']['get']>,
): string | null {
  if (node?.kind !== ASSISTANT_FLOW_KIND) return null
  const data = node.data
  if (typeof data !== 'object' || data === null) return null
  const finalNode = (data as { readonly finalNode?: unknown }).finalNode
  if (typeof finalNode !== 'object' || finalNode === null) return null
  const messageId = (finalNode as { readonly messageId?: unknown }).messageId
  return typeof messageId === 'string' ? messageId : null
}

/** 查找一个已完成助手消息对应的 Chat Node key。 */
export function assistantMessageNodeKey(
  snapshot: ChatOrderSnapshot,
  messageId: string,
): string | null {
  for (const key of snapshot.order) {
    if (key !== undefined && finalizedAssistantMessageId(snapshot.nodes.get(key)) === messageId) return key
  }
  return null
}

/** 查找一个已渲染的助手行，优先使用 snapshot 的稳定 key。 */
export function findAssistantMessageRow(root: ParentNode, preferredKey: string | null): HTMLElement | null {
  const rows = Array.from(root.querySelectorAll<HTMLElement>(`[data-chat-flow-kind="${ASSISTANT_FLOW_KIND}"]`))
  if (preferredKey !== null) {
    const preferred = rows.find(row => row.dataset.chatFlowKey === preferredKey)
    if (preferred === undefined || preferred.hidden) return preferred ?? null
    return preferred
  }
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]
    if (row !== undefined && !row.hidden) return row
  }
  return rows.at(-1) ?? null
}

/** 计算把行放到转录阅读线上的 scrollTop。 */
export function scrollTopForMessage(
  currentScrollTop: number,
  rowTop: number,
  scrollportTop: number,
  inset = READING_LINE_INSET_PX,
): number {
  return Math.max(0, currentScrollTop + rowTop - scrollportTop - inset)
}

/** 判断行是否已到达目标阅读线。 */
export function messageReachedReadingLine(
  rowTop: number,
  scrollportTop: number,
  inset = READING_LINE_INSET_PX,
  tolerance = 2,
): boolean {
  return Math.abs(rowTop - scrollportTop - inset) <= tolerance
}

/** 计算到达目标 scrollTop 还需要的临时 bottom cushion。 */
export function bottomCushionForTarget(
  targetScrollTop: number,
  scrollHeight: number,
  clientHeight: number,
): number {
  const naturalFloor = Math.max(0, scrollHeight - clientHeight)
  return Math.max(0, Math.ceil(targetScrollTop - naturalFloor))
}

/** 在 dsh 的两种会话布局中查找真正的滚动 owner。 */
export function findScrollport(row: HTMLElement): HTMLElement | null {
  const conversationScroll = row.closest<HTMLElement>('[data-conversation-scroll]')
  if (conversationScroll !== null) return conversationScroll

  const view = row.ownerDocument.defaultView
  let ancestor = row.parentElement
  while (ancestor !== null) {
    if (view !== null) {
      const overflow = view.getComputedStyle(ancestor).overflowY
      if (overflow === 'auto' || overflow === 'scroll' || overflow === 'overlay') return ancestor
    }
    ancestor = ancestor.parentElement
  }
  return row.ownerDocument.scrollingElement as HTMLElement | null
}

/** 平滑移动真正的滚动 owner 并返回目标位置。 */
export function scrollMessageToTop(
  row: HTMLElement,
  scrollport: HTMLElement,
  behavior: ScrollBehavior,
  inset = READING_LINE_INSET_PX,
): number {
  const rowRect = row.getBoundingClientRect()
  const scrollportRect = scrollport.getBoundingClientRect()
  const target = scrollTopForMessage(
    scrollport.scrollTop,
    rowRect.top,
    scrollportRect.top,
    inset,
  )
  if (typeof scrollport.scrollTo === 'function') scrollport.scrollTo({ top: target, behavior })
  else scrollport.scrollTop = target
  return target
}

/** 将分界线裁剪到消息行可见的水平范围。 */
export function dividerGeometry(
  row: Pick<DOMRect, 'left' | 'right' | 'top'>,
  scrollport: Pick<DOMRect, 'left' | 'right'>,
): { left: number; top: number; width: number } {
  const left = Math.max(row.left, scrollport.left)
  const right = Math.min(row.right, scrollport.right)
  return { left, top: row.top, width: Math.max(1, right - left) }
}
