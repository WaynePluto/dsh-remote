import { useEffect, useRef } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// dock mount 不渲染可见内容，只为 bottom navigation 提供生命周期入口。
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { installBottomNavigation } from './bottom.js'

/** 不可见的会话级导航挂载点的完整 props。 */
export type ScrollNavigationMountProps = PropsRuntime<'conversation.input.dock'>

/** 界面契约：此处说明布局、主题 token、尺寸或 DOM 接缝。 */
export function ScrollNavigationMount({ sessionId }: ScrollNavigationMountProps) {
  const mountRef = useRef<HTMLSpanElement | null>(null)
  useEffect(() => {
    const mount = mountRef.current
    if (mount === null) return
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
    return installBottomNavigation({ mount, reducedMotion })
  }, [sessionId])
  return <span ref={mountRef} hidden data-dshx-scroll-navigation aria-hidden />
}

