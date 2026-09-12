/** 由真实布局帧驱动、具有边界且可取消的滚动动画。 */
export interface ScrollAnimationOptions {
  readonly scrollport: HTMLElement
  /** 重新读取绝对目标；移动过程中布局可能变化。 */
  readonly getTarget: () => number
  readonly reducedMotion: boolean
  readonly durationMs?: number
  readonly maxDurationMs: number
  readonly onLand: () => void
  readonly onTimeout: () => void
}

const LANDING_TOLERANCE_PX = 2
const MIN_DURATION_MS = 180
const DEFAULT_DURATION_MS = 320

/** 设置写入契约：此处说明命名空间、校验、回读确认和草稿保留。（涉及：`scroll-behavior`） */
export function startScrollAnimation(options: ScrollAnimationOptions): () => void {
  const startedAt = Date.now()
  const from = options.scrollport.scrollTop
  const configuredDuration = options.durationMs ?? DEFAULT_DURATION_MS
  const duration = Math.min(
    options.maxDurationMs,
    Math.max(MIN_DURATION_MS, configuredDuration),
  )
  let frame: number | null = null
  let stopped = false
  let completed = false

  const stop = (): void => {
    stopped = true
    if (frame !== null) window.cancelAnimationFrame(frame)
    frame = null
  }

  const finish = (landed: boolean): void => {
    if (stopped || completed) return
    completed = true
    stop()
    if (landed) options.onLand()
    else options.onTimeout()
  }

  const tick = (): void => {
    if (stopped || completed) return
    frame = null
    const now = Date.now()
    const target = options.getTarget()
    const current = options.scrollport.scrollTop
    const distance = target - current
    if (Math.abs(distance) <= LANDING_TOLERANCE_PX) {
      // 最后一次写入消除小数残差，同时仍遵守
      // 浏览器当前的 clamp；下一次检查确认真实盒子。
      options.scrollport.scrollTop = target
      frame = window.requestAnimationFrame(() => {
        frame = null
        if (Math.abs(options.getTarget() - options.scrollport.scrollTop) <= LANDING_TOLERANCE_PX) {
          finish(true)
        } else if (Date.now() - startedAt >= options.maxDurationMs) {
          finish(false)
        } else {
          tick()
        }
      })
      return
    }
    if (now - startedAt >= options.maxDurationMs) {
      finish(false)
      return
    }

    if (options.reducedMotion) {
      options.scrollport.scrollTop = target
    } else {
      const progress = Math.min(1, Math.max(0, (now - startedAt) / duration))
      const eased = 1 - ((1 - progress) ** 3)
      const next = from + (target - from) * eased
      if (Math.abs(next - current) > 0.1) options.scrollport.scrollTop = next
    }
    frame = window.requestAnimationFrame(tick)
  }

  tick()
  return stop
}

/** 消息导航和底部导航共用的时长辅助函数。 */
export function durationForDistance(distance: number): number {
  return Math.min(440, Math.max(MIN_DURATION_MS, 180 + Math.abs(distance) * 0.18))
}
