import { useCallback, useEffect, useRef } from 'react'
import { IconChevronUpOutlineMedium, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
// 仅类型：激活 Chat 和 conversation slot merge。
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
// 仅类型：激活 Chat 和 conversation slot merge。
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  assistantMessageNodeKey, bottomCushionForTarget, dividerGeometry, scrollTopForMessage,
} from './locate.js'
import { startMessageLanding } from './landing.js'
import { ACTION_CLASS, CUSHION_PROPERTY, FLASH_CLASS } from './styles.js'

/** 一个已完成助手消息操作的完整 props。 */
export type AgentMessageStartButtonProps =
  PropsRuntime<'conversation.chat.assistant-actions'>
  & PropsLocale<'dsh-plugin-chat-scroll'>

interface ActiveCushion {
  readonly owner: object
  readonly root: HTMLElement
  readonly scrollport: HTMLElement
  readonly previousValue: string
  readonly previousPriority: string
  readonly clearOnInput: EventListener
}

let activeCushion: ActiveCushion | null = null

/** 只移除调用方拥有的 cushion；未传 owner 时移除任意 cushion。 */
function clearBottomCushion(owner?: object): void {
  const cushion = activeCushion
  if (cushion === null || (owner !== undefined && cushion.owner !== owner)) return
  activeCushion = null
  cushion.scrollport.removeEventListener('pointerdown', cushion.clearOnInput, true)
  cushion.scrollport.removeEventListener('wheel', cushion.clearOnInput, true)
  cushion.scrollport.removeEventListener('keydown', cushion.clearOnInput, true)
  if (cushion.previousValue === '') cushion.root.style.removeProperty(CUSHION_PROPERTY)
  else cushion.root.style.setProperty(CUSHION_PROPERTY, cushion.previousValue, cushion.previousPriority)
}

/** 为较短的最终回答保留足够临时尾部空间，使其能对齐阅读线。 */
function setBottomCushion(
  owner: object,
  root: HTMLElement,
  scrollport: HTMLElement,
  pixels: number,
): void {
  clearBottomCushion()
  if (pixels <= 0) return
  const clearOnInput: EventListener = () => { clearBottomCushion(owner) }
  activeCushion = {
    owner,
    root,
    scrollport,
    previousValue: root.style.getPropertyValue(CUSHION_PROPERTY),
    previousPriority: root.style.getPropertyPriority(CUSHION_PROPERTY),
    clearOnInput,
  }
  scrollport.addEventListener('pointerdown', clearOnInput, { capture: true, passive: true })
  scrollport.addEventListener('wheel', clearOnInput, { capture: true, passive: true })
  scrollport.addEventListener('keydown', clearOnInput, { capture: true })
  root.style.setProperty(CUSHION_PROPERTY, `${String(pixels)}px`)
}

/** 跳转到所属助手消息的紧凑操作组按钮。 */
export function AgentMessageStartButton({ messageId, sessionId, useChat, t }: AgentMessageStartButtonProps) {
  const messageKey = useChat(snapshot => assistantMessageNodeKey(snapshot, String(messageId)))
  const flashRef = useRef<HTMLDivElement | null>(null)
  const landingRef = useRef<(() => void) | null>(null)
  const cushionOwner = useRef<object>({})
  const animationToken = useRef(0)
  const animationEndHandler = useRef<((event: AnimationEvent) => void) | null>(null)

  const clearFlash = useCallback(() => {
    const line = flashRef.current
    const handler = animationEndHandler.current
    if (line !== null && handler !== null) line.removeEventListener('animationend', handler)
    animationEndHandler.current = null
    animationToken.current += 1
    line?.removeAttribute('data-active')
  }, [])

  const cancelLanding = useCallback(() => {
    landingRef.current?.()
    landingRef.current = null
    clearBottomCushion(cushionOwner.current)
    clearFlash()
  }, [clearFlash])

  const placeFlash = useCallback((row: HTMLElement, scrollport: HTMLElement) => {
    const line = flashRef.current
    if (line === null) return
    const geometry = dividerGeometry(row.getBoundingClientRect(), scrollport.getBoundingClientRect())
    line.style.left = `${String(geometry.left)}px`
    line.style.top = `${String(geometry.top)}px`
    line.style.width = `${String(geometry.width)}px`
  }, [])

  const showFlash = useCallback((row: HTMLElement, scrollport: HTMLElement) => {
    const line = flashRef.current
    if (line === null) return
    placeFlash(row, scrollport)
    clearFlash()
    const token = ++animationToken.current
    // 重复点击操作时重新启动同一段短动画。
    void line.offsetWidth
    const handler = (event: AnimationEvent): void => {
      if (event.target !== line || animationToken.current !== token) return
      line.removeAttribute('data-active')
      animationEndHandler.current = null
    }
    animationEndHandler.current = handler
    line.addEventListener('animationend', handler, { once: true })
    line.setAttribute('data-active', '')
  }, [clearFlash, placeFlash])

  const locate = useCallback(() => {
    if (messageKey === null) return
    cancelLanding()
    const root = flashRef.current?.closest<HTMLElement>('[data-chat-flow]') ?? document
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
    landingRef.current = startMessageLanding({
      root,
      messageKey,
      reducedMotion,
      prepare: (row, scrollport) => {
        clearBottomCushion()
        const rowRect = row.getBoundingClientRect()
        const scrollportRect = scrollport.getBoundingClientRect()
        const target = scrollTopForMessage(scrollport.scrollTop, rowRect.top, scrollportRect.top)
        const cushion = bottomCushionForTarget(target, scrollport.scrollHeight, scrollport.clientHeight)
        const flowRoot = row.closest<HTMLElement>('[data-chat-flow]')
        if (flowRoot !== null) setBottomCushion(cushionOwner.current, flowRoot, scrollport, cushion)
      },
      onLand: showFlash,
    })
  }, [cancelLanding, messageKey, showFlash])

  // flow key 可能在不同会话中重复；任一身份变化都会取消跳转。
  useEffect(() => {
    cancelLanding()
    return () => { cancelLanding() }
  }, [cancelLanding, messageKey, sessionId])

  if (messageKey === null) return null

  return (
    <>
      <Tooltip label={t('locate')} side="bottom">
        <button
          type="button"
          className={ACTION_CLASS}
          aria-label={t('locate')}
          onClick={locate}
        >
          <IconChevronUpOutlineMedium />
        </button>
      </Tooltip>
      <div ref={flashRef} className={FLASH_CLASS} aria-hidden />
    </>
  )
}
