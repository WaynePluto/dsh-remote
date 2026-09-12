/** 设置写入契约：此处说明命名空间、校验、回读确认和草稿保留。（涉及：`github-copilot`、`settings.models.provider-card`、`.editor`） */

import { createPortal } from 'react-dom'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode, RefObject } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import type { ProviderCardExtrasOwnerProps } from '@deepseek-ai/dsh-client-ui-settings-models/client'
import type { CopilotStatusView } from '../shared.js'
import { PROVIDER_ID } from '../shared.js'
import { fill } from './locales.js'
import type { CopilotKey } from './locales.js'

/** 页面打开时重新读取进行中尝试的间隔。 */
const POLL_INTERVAL_MS = 2000

/** 界面契约：此处说明布局、主题 token、尺寸或 DOM 接缝。 */
const PROVIDER_CARD_SELECTOR = [
  '[class*="_rowCard"]',
  '[class*="_setupCard"]',
  '[class*="_addCard"]',
].join(', ')
const EDITOR_SELECTOR = '[class*="_editor"]'
const FIELD_SELECTOR = '[class*="_field"]'
const CUSTOMIZED_SELECTOR = '[class*="_customized"]'
const EDITOR_ACTIONS_SELECTOR = '[class*="_editorActions"]'
const EDITOR_HOST_ATTRIBUTE = 'data-dsh-plugin-copilot-auth-editor-host'

/** 模型目录契约：此处说明 provider、协议、目录覆盖和用户条目保留。 */
function editorFor(anchor: HTMLElement): HTMLElement | null {
  const card = anchor.closest<HTMLElement>(PROVIDER_CARD_SELECTOR)
  const editor = card?.querySelector<HTMLElement>(EDITOR_SELECTOR)
  return editor?.isConnected === true ? editor : null
}

/** 会话与投影契约：此处说明持久事件、投影状态或历史回放边界。 */
function hostFor(editor: HTMLElement): HTMLElement {
  const existing = editor.querySelector<HTMLElement>(`[${EDITOR_HOST_ATTRIBUTE}]`)
  if (existing !== null) return existing

  const host = document.createElement('div')
  host.setAttribute(EDITOR_HOST_ATTRIBUTE, '')
  host.style.display = 'contents'
  const before = editor.querySelector<HTMLElement>(FIELD_SELECTOR)
    ?? editor.querySelector<HTMLElement>(CUSTOMIZED_SELECTOR)
    ?? editor.querySelector<HTMLElement>(EDITOR_ACTIONS_SELECTOR)
  editor.insertBefore(host, before)
  return host
}

/** 实现说明：此处记录相关接口、边界和生命周期约束。 */
function removeEmptyHost(host: HTMLElement): void {
  queueMicrotask(() => {
    if (host.isConnected && host.childNodes.length === 0) host.remove()
  })
}

/** 模型目录契约：此处说明 provider、协议、目录覆盖和用户条目保留。 */
function useEditorPortal(): { anchorRef: RefObject<HTMLSpanElement>; host: HTMLElement | null } {
  const anchorRef = useRef<HTMLSpanElement>(null)
  const [host, setHost] = useState<HTMLElement | null>(null)
  const hostRef = useRef<HTMLElement | null>(null)

  useLayoutEffect(() => {
    const anchor = anchorRef.current
    if (anchor === null) return
    const card = anchor.closest<HTMLElement>(PROVIDER_CARD_SELECTOR)
    if (card === null) return

    let disposed = false
    let pending = false
    const sync = (): void => {
      pending = false
      if (disposed) return
      const editor = editorFor(anchor)
      const next = editor === null ? null : hostFor(editor)
      const previous = hostRef.current
      hostRef.current = next
      if (previous !== null && previous !== next) removeEmptyHost(previous)
      setHost(current => current === next ? current : next)
    }
    const schedule = (): void => {
      if (pending) return
      pending = true
      queueMicrotask(sync)
    }

    sync()
    const observer = new MutationObserver(schedule)
    observer.observe(card, { childList: true, subtree: true })
    return () => {
      disposed = true
      observer.disconnect()
      const previous = hostRef.current
      hostRef.current = null
      if (previous !== null) removeEmptyHost(previous)
    }
  }, [])

  return { anchorRef, host }
}

/** 模型目录契约：此处说明 provider、协议、目录覆盖和用户条目保留。 */
export type ProviderCardOwnerProps = ProviderCardExtrasOwnerProps

/** 实现说明：此处记录相关接口、边界和生命周期约束。 */
type ProviderCardChildren = Partial<PropsRenderSlots<'settings.models.provider-card.capabilities'>>

/** 实现说明：此处记录相关接口、边界和生命周期约束。 */
export interface CopilotCardInjected {
  /** 传输契约：此处说明 RPC 端点、路径段、Host/Origin 围栏或认证边界。 */
  call: (endpoint: string) => Promise<CopilotStatusView>
}

/** 实现说明：此处记录相关接口、边界和生命周期约束。 */
export type CopilotCardProps = ProviderCardOwnerProps & ProviderCardChildren & Partial<CopilotCardInjected> & {
  /** 设置写入契约：此处说明命名空间、校验、回读确认和草稿保留。 */
  t?: (key: CopilotKey) => string
}

const areaStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '8px',
  fontSize: '13px',
}

const rowStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }

const mutedStyle: CSSProperties = { color: 'var(--dsw-alias-label-secondary, #6b7280)' }

const codeStyle: CSSProperties = {
  fontFamily: 'var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
  fontSize: '18px',
  letterSpacing: '2px',
  padding: '4px 10px',
  borderRadius: '6px',
  background: 'var(--dsw-alias-markdown-inline-code, rgba(128,128,128,0.14))',
}

const errorStyle: CSSProperties = { color: 'var(--dsw-alias-state-error-primary, #dc2626)' }

/** 实现说明：此处记录相关接口、边界和生命周期约束。 */
function minutesLeft(expiresAt: number, now: number): number {
  return Math.max(0, Math.ceil((expiresAt - now) / 60000))
}

/** 实现说明：此处记录相关接口、边界和生命周期约束。 */
export function CopilotProviderCard(props: CopilotCardProps): ReactNode {
  const { provider, call, t, renderSlot } = props
  const isCopilot = provider.provider === PROVIDER_ID
  const capabilities = renderSlot === undefined
    ? null
    : renderSlot(
      'settings.models.provider-card.capabilities',
      { provider, configured: props.configured, keyConfigured: props.keyConfigured },
    )
  const { anchorRef, host } = useEditorPortal()
  const [status, setStatus] = useState<CopilotStatusView | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  // 实现说明：此处记录相关接口、边界和生命周期约束。（涉及：`status`）
  // 覆盖用户刚按下 `start` 得到的更新答案。
  const generation = useRef(0)

  const run = useCallback(async (endpoint: string): Promise<void> => {
    if (call === undefined) return
    const mine = ++generation.current
    try {
      const next = await call(endpoint)
      if (generation.current === mine) setStatus(next)
    } catch {
      // poll 失败不值得单独提示：connection layer
      // 已报告传输失败，下一次 tick 会重试。
    }
  }, [call])

  const act = useCallback(async (endpoint: string): Promise<void> => {
    setBusy(true)
    try {
      await run(endpoint)
    } finally {
      setBusy(false)
    }
  }, [run])

  useEffect(() => {
    if (!isCopilot) return
    void run('status')
  }, [isCopilot, run])

  const attempt = status?.attempt
  useEffect(() => {
    if (!isCopilot || attempt === undefined) return
    const timer = setInterval(() => { void run('status') }, POLL_INTERVAL_MS)
    return () => { clearInterval(timer) }
  }, [isCopilot, attempt, run])

  if (!isCopilot) {
    return (
      <>
        <span ref={anchorRef} data-dsh-plugin-copilot-auth-anchor="" hidden aria-hidden="true" />
        {host === null ? null : createPortal(capabilities, host)}
      </>
    )
  }
  const text = (key: CopilotKey): string => t?.(key) ?? key

  const copy = (value: string): void => {
    void (async () => {
      try {
        await navigator.clipboard?.writeText(value)
        setCopied(true)
      } catch {
        // 部分浏览器在普通 HTTP 下拒绝剪贴板访问；code
        // 仍可在屏幕上选择，这始终是回退方案。
      }
    })()
  }

  return (
    <>
      <span ref={anchorRef} data-dsh-plugin-copilot-auth-anchor="" hidden aria-hidden="true" />
      {host === null ? null : createPortal(
        <>
          <style>{`
            [class*="_editor"]:has(> [data-dsh-plugin-copilot-auth-editor-host] > [data-dsh-copilot-subscription])
              > [class*="_field"]:has(> input[type="password"]) {
              display: none !important;
            }
          `}</style>
          <div style={areaStyle} data-dsh-copilot-subscription="">
            <div style={{ fontWeight: 600 }}>{text('title')}</div>
      {attempt === undefined
        ? (
            <>
              <div style={mutedStyle}>
                {status?.signedIn === true
                  ? status.routeConfigured
                    ? status.modelIds.length > 0
                      ? fill(text('signedIn'), { count: status.modelIds.length })
                      : text('signedInUnknown')
                    : text('routeMissing')
                  : text('intro')}
              </div>
              {status?.error === undefined
                ? null
                : <div style={errorStyle}>{fill(text('failed'), { message: status.error })}</div>}
              {status?.warning === undefined
                ? null
                : <div style={errorStyle}>{fill(text('routeFailed'), { message: status.warning })}</div>}
              <div style={rowStyle}>
                <Button
                  variant="primary"
                  size="sm"
                  disabled={busy}
                  onClick={() => { void act('start') }}
                >
                  {busy ? text('busy') : status?.signedIn === true ? text('signInAgain') : text('signIn')}
                </Button>
                {status?.signedIn === true && !status.routeConfigured
                  ? (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy}
                        onClick={() => { void act('configure') }}
                      >
                        {text('configure')}
                      </Button>
                    )
                  : null}
                {status?.signedIn === true
                  ? (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy}
                        onClick={() => { void act('sign-out') }}
                      >
                        {text('signOut')}
                      </Button>
                    )
                  : null}
              </div>
            </>
          )
        : (
            <>
              <div style={mutedStyle}>
                {attempt.phase === 'awaiting' ? text('awaiting') : attempt.phase === 'finishing' ? text('finishing') : text('starting')}
              </div>
              {attempt.userCode === undefined
                ? null
                : (
                    <div style={rowStyle}>
                      <code style={codeStyle}>{attempt.userCode}</code>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => { copy(attempt.userCode ?? '') }}
                      >
                        {copied ? text('copied') : text('copy')}
                      </Button>
                    </div>
                  )}
              {attempt.verificationUri === undefined
                ? null
                : (
                    <div style={rowStyle}>
                      <a href={attempt.verificationUri} target="_blank" rel="noreferrer noopener">
                        {text('openPage')}
                      </a>
                      <span style={mutedStyle}>{attempt.verificationUri}</span>
                    </div>
                  )}
              {attempt.expiresAt === undefined
                ? null
                : (
                    <div style={mutedStyle}>
                      {minutesLeft(attempt.expiresAt, Date.now()) === 0
                        ? text('expired')
                        : fill(text('expiresIn'), { minutes: minutesLeft(attempt.expiresAt, Date.now()) })}
                    </div>
                  )}
              {attempt.message === undefined ? null : <div style={mutedStyle}>{attempt.message}</div>}
              <div style={rowStyle}>
                <Button variant="outline" size="sm" disabled={busy} onClick={() => { void act('cancel') }}>
                  {text('cancel')}
                </Button>
              </div>
            </>
          )}
          </div>
          {capabilities}
        </>,
      host)}
    </>
  )
}
