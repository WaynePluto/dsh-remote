/**
 * The sign-in area rendered inside the `github-copilot` provider card on dsh's
 * Models page.
 *
 * It occupies `settings.models.provider-card`, the extension seat that page
 * declares for adapter families (`ProviderCardExtrasOwnerProps`), keyed by the
 * owning settings namespace — so this component is handed every pi-ai card and
 * renders for exactly one of them. The card's own API-key field stays where it
 * is: the seat is an addition to a card, not a replacement for it, and a
 * Copilot subscription simply has no key to put there.
 *
 * Styling uses dsh's own `--dsw-*` theme tokens with fallbacks, so the area
 * follows light/dark without this package shipping a stylesheet the loader
 * would have to compile.
 *
 * @module @dsh-remote/dsh-plugin-copilot-auth/client/CopilotCard
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type { CopilotStatusView } from '../shared.js'
import { PROVIDER_ID } from '../shared.js'
import { fill } from './locales.js'
import type { CopilotKey } from './locales.js'

/** How often a running attempt is re-read while the page is open. */
const POLL_INTERVAL_MS = 2000

/** What the Models page hands every card of this family. */
export interface ProviderCardOwnerProps {
  /** The card's directory row; `provider` is the route id. */
  provider: { provider: string }
}

/** What this plugin injects into its own registration. */
export interface CopilotCardInjected {
  /** Call one endpoint of this plugin's channel. */
  call: (endpoint: string) => Promise<CopilotStatusView>
}

/** Everything the component reads. */
export type CopilotCardProps = ProviderCardOwnerProps & Partial<CopilotCardInjected> & {
  /** Locale seat bound to this plugin's namespace. */
  t?: (key: CopilotKey) => string
}

const areaStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '8px',
  marginTop: '12px',
  paddingTop: '12px',
  borderTop: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.2))',
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

const buttonStyle: CSSProperties = {
  padding: '6px 12px',
  borderRadius: '8px',
  border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3))',
  background: 'transparent',
  color: 'inherit',
  cursor: 'pointer',
  font: 'inherit',
}

const primaryButtonStyle: CSSProperties = {
  ...buttonStyle,
  border: '1px solid transparent',
  background: 'var(--dsw-alias-button-primary-fill, #1f2937)',
  color: 'var(--dsw-alias-label-primary-inverted, #fff)',
}

const errorStyle: CSSProperties = { color: 'var(--dsw-alias-state-error-primary, #dc2626)' }

/** Whole minutes left before a device code expires, floored at zero. */
function minutesLeft(expiresAt: number, now: number): number {
  return Math.max(0, Math.ceil((expiresAt - now) / 60000))
}

/**
 * The Copilot sign-in area.
 * @param props - owner share, injected callbacks, and the locale seat.
 * @returns the area, or nothing for a card that is not GitHub Copilot's.
 */
export function CopilotProviderCard(props: CopilotCardProps): ReactNode {
  const { provider, call, t } = props
  const isCopilot = provider.provider === PROVIDER_ID
  const [status, setStatus] = useState<CopilotStatusView | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  // Only the latest request may write state: a slow `status` poll must not
  // overwrite the fresher answer of the `start` the human just pressed.
  const generation = useRef(0)

  const run = useCallback(async (endpoint: string): Promise<void> => {
    if (call === undefined) return
    const mine = ++generation.current
    try {
      const next = await call(endpoint)
      if (generation.current === mine) setStatus(next)
    } catch {
      // A failed poll is not worth a message of its own: the connection layer
      // already reports transport failures, and the next tick retries.
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

  if (!isCopilot) return null
  const text = (key: CopilotKey): string => t?.(key) ?? key

  const copy = (value: string): void => {
    void (async () => {
      try {
        await navigator.clipboard?.writeText(value)
        setCopied(true)
      } catch {
        // Clipboard access is denied on some browsers over plain HTTP; the code
        // stays selectable on screen, which is the fallback either way.
      }
    })()
  }

  return (
    <div style={areaStyle}>
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
                <button
                  type="button"
                  style={primaryButtonStyle}
                  disabled={busy}
                  onClick={() => { void act('start') }}
                >
                  {busy ? text('busy') : status?.signedIn === true ? text('signInAgain') : text('signIn')}
                </button>
                {status?.signedIn === true && !status.routeConfigured
                  ? (
                      <button
                        type="button"
                        style={buttonStyle}
                        disabled={busy}
                        onClick={() => { void act('configure') }}
                      >
                        {text('configure')}
                      </button>
                    )
                  : null}
                {status?.signedIn === true
                  ? (
                      <button
                        type="button"
                        style={buttonStyle}
                        disabled={busy}
                        onClick={() => { void act('sign-out') }}
                      >
                        {text('signOut')}
                      </button>
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
                      <button
                        type="button"
                        style={buttonStyle}
                        onClick={() => { copy(attempt.userCode ?? '') }}
                      >
                        {copied ? text('copied') : text('copy')}
                      </button>
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
                <button type="button" style={buttonStyle} disabled={busy} onClick={() => { void act('cancel') }}>
                  {text('cancel')}
                </button>
              </div>
            </>
          )}
    </div>
  )
}
