import {
  findAssistantMessageRow, findScrollport, MAX_LANDING_WAIT_MS, MAX_TARGET_WAIT_MS,
  scrollTopForMessage,
} from './locate.js'
import { durationForDistance, startScrollAnimation } from './animation.js'

interface MessageLandingOptions {
  /** 即使另一个会话正在挂载，也保持在所属 flow 内。 */
  readonly root: ParentNode
  readonly messageKey: string
  readonly reducedMotion: boolean
  /** 首次写入滚动位置前补足缺失的尾部空间。 */
  prepare(row: HTMLElement, scrollport: HTMLElement): void
  /** 只有几何测量确认到达目标行后才调用。 */
  onLand(row: HTMLElement, scrollport: HTMLElement): void
}

/** 设置写入契约：此处说明命名空间、校验、回读确认和草稿保留。 */
export function startMessageLanding(options: MessageLandingOptions): () => void {
  const startedAt = Date.now()
  let frame: number | null = null
  let animationStop: (() => void) | null = null
  let stopped = false
  let row: HTMLElement | null = null
  let scrollport: HTMLElement | null = null

  const removeInputListeners = (): void => {
    scrollport?.removeEventListener('pointerdown', stop, true)
    scrollport?.removeEventListener('wheel', stop, true)
    scrollport?.removeEventListener('keydown', stop, true)
  }

  function stop(): void {
    if (stopped) return
    stopped = true
    if (frame !== null) window.cancelAnimationFrame(frame)
    frame = null
    animationStop?.()
    animationStop = null
    removeInputListeners()
  }

  const settle = (): void => {
    if (stopped) return
    frame = null
    const now = Date.now()
    const nextRow = findAssistantMessageRow(options.root, options.messageKey)
    const nextPort = nextRow === null ? null : findScrollport(nextRow)
    if (nextRow === null || nextPort === null) {
      if (now - startedAt >= MAX_TARGET_WAIT_MS) stop()
      else frame = window.requestAnimationFrame(settle)
      return
    }

    if (row === nextRow && scrollport === nextPort) return
    removeInputListeners()
    row = nextRow
    scrollport = nextPort
    scrollport.addEventListener('pointerdown', stop, { capture: true, passive: true })
    scrollport.addEventListener('wheel', stop, { capture: true, passive: true })
    scrollport.addEventListener('keydown', stop, { capture: true })
    options.prepare(row, scrollport)
    const initialTarget = targetFor(row, scrollport)
    animationStop = startScrollAnimation({
      scrollport,
      getTarget: () => targetFor(row, scrollport),
      reducedMotion: options.reducedMotion,
      durationMs: durationForDistance(initialTarget - scrollport.scrollTop),
      maxDurationMs: MAX_LANDING_WAIT_MS,
      onLand: () => {
        animationStop = null
        stopped = true
        removeInputListeners()
        options.onLand(row as HTMLElement, scrollport as HTMLElement)
      },
      onTimeout: () => {
        animationStop = null
        stopped = true
        removeInputListeners()
      },
    })
  }

  settle()
  return stop
}

function targetFor(row: HTMLElement | null, scrollport: HTMLElement | null): number {
  if (row === null || scrollport === null) return 0
  return scrollTopForMessage(
    scrollport.scrollTop,
    row.getBoundingClientRect().top,
    scrollport.getBoundingClientRect().top,
  )
}
