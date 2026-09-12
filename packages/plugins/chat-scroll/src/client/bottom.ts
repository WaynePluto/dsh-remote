import { durationForDistance, startScrollAnimation } from './animation.js'

/** dsh 唯一底部导航按钮的本地化标签。 */
const BOTTOM_LABELS = new Set(['回到底部', 'Back to bottom'])
/** 动画接近 dsh 的 25px 底部阈值带时保持按钮挂载。 */
export const BOTTOM_HANDOFF_GAP_PX = 27

export interface BottomNavigationMount {
  readonly mount: HTMLElement
  readonly reducedMotion: boolean
}

/** 在 dsh 原生底部按钮周围安装会话级捕获接缝。 */
export function installBottomNavigation({ mount, reducedMotion }: BottomNavigationMount): () => void {
  const scrollport = scrollportOf(mount)
  if (scrollport === null) return () => {}
  let animationStop: (() => void) | null = null
  let removeInputListeners: (() => void) | null = null
  let replaying = false
  let disposed = false

  const cancel = (): void => {
    animationStop?.()
    animationStop = null
    removeInputListeners?.()
    removeInputListeners = null
  }

  const onReaderInput = (): void => { cancel() }

  const start = (original: HTMLButtonElement): void => {
    cancel()
    const initialTarget = handoffTarget(scrollport)
    const distance = initialTarget - scrollport.scrollTop
    const finish = (): void => {
      animationStop = null
      removeInputListeners?.()
      removeInputListeners = null
      replayNativeBottom(original, scrollport, () => { replaying = true }, () => { replaying = false })
    }
    const timeout = (): void => {
      animationStop = null
      removeInputListeners?.()
      removeInputListeners = null
      // 动画停滞不能让已阻止的点击变成无操作；如果
      // 原始接缝仍挂载，就让 dsh 执行权威的
      // 状态转换；否则按钮通常已在
      // dsh 识别到底部阈值后消失。
      if (original.isConnected && findBottomButton(scrollport) !== null) {
        replayNativeBottom(original, scrollport, () => { replaying = true }, () => { replaying = false })
      }
    }
    const onPointerDown = (): void => { onReaderInput() }
    const onWheel = (): void => { onReaderInput() }
    const onKeyDown = (): void => { onReaderInput() }
    scrollport.addEventListener('pointerdown', onPointerDown, { capture: true, passive: true })
    scrollport.addEventListener('wheel', onWheel, { capture: true, passive: true })
    scrollport.addEventListener('keydown', onKeyDown, { capture: true })
    removeInputListeners = () => {
      scrollport.removeEventListener('pointerdown', onPointerDown, true)
      scrollport.removeEventListener('wheel', onWheel, true)
      scrollport.removeEventListener('keydown', onKeyDown, true)
    }
    animationStop = startScrollAnimation({
      scrollport,
      getTarget: () => handoffTarget(scrollport),
      reducedMotion,
      durationMs: durationForDistance(distance),
      maxDurationMs: 1_800,
      onLand: finish,
      onTimeout: timeout,
    })
  }

  const onClick = (event: MouseEvent): void => {
    if (disposed || replaying) return
    const target = event.target
    const button = target instanceof Element ? target.closest('button') : null
    if (!(button instanceof HTMLButtonElement) || !isBottomButton(button, scrollport)) return
    // React 委托的 onClick 位于该捕获监听器上层；只有在按钮通过严格的
    // 原生身份检查后才停止传播。
    event.preventDefault()
    event.stopPropagation()
    start(button)
  }

  scrollport.addEventListener('click', onClick, true)
  return () => {
    disposed = true
    cancel()
    scrollport.removeEventListener('click', onClick, true)
  }
}

/** 不假设 ChatView 局部溢出模式，定位真正的滚动 owner。 */
function scrollportOf(mount: HTMLElement): HTMLElement | null {
  const conversation = mount.closest<HTMLElement>('[data-conversation-scroll]')
  if (conversation !== null) return conversation
  const view = mount.ownerDocument.defaultView
  let ancestor = mount.parentElement
  while (ancestor !== null) {
    const overflow = view?.getComputedStyle(ancestor).overflowY
    if (overflow === 'auto' || overflow === 'scroll' || overflow === 'overlay') return ancestor
    ancestor = ancestor.parentElement
  }
  return mount.ownerDocument.scrollingElement as HTMLElement | null
}

export function isBottomButton(button: HTMLButtonElement, scrollport: HTMLElement): boolean {
  if (button.closest('[data-conversation-scroll]') !== scrollport) return false
  const label = button.getAttribute('aria-label')
  if (label === null || !BOTTOM_LABELS.has(label)) return false
  // 原生控件是图标按钮；要求存在 SVG，避免拦截
  // 恰好复用该 locale 标签的未来文本或链接控件。
  return button.querySelector('svg') !== null
}

function findBottomButton(scrollport: HTMLElement): HTMLButtonElement | null {
  for (const button of scrollport.querySelectorAll<HTMLButtonElement>('button')) {
    if (isBottomButton(button, scrollport)) return button
  }
  return null
}

function handoffTarget(scrollport: HTMLElement): number {
  const floor = Math.max(0, scrollport.scrollHeight - scrollport.clientHeight)
  return Math.max(0, floor - BOTTOM_HANDOFF_GAP_PX)
}

function replayNativeBottom(
  original: HTMLButtonElement,
  scrollport: HTMLElement,
  before: () => void,
  after: () => void,
): void {
  const button = findBottomButton(scrollport) ?? (original.isConnected ? original : null)
  if (button === null) {
    // 如果 dsh 已移除按钮，说明它自己的 atBottom 状态已经生效。
    // 不要在已脱离的 React 节点上伪造点击。
    return
  }
  before()
  try {
    button.click()
  } finally {
    after()
  }
}
