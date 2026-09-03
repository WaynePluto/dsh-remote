/**
 * The banner, rendered full width above the composer.
 *
 * WHY THE INPUT DOCK AND NOT THE TRANSCRIPT. The obvious home for this would
 * be under the red row dsh already draws for a failed turn — but that row is a
 * keyed Chat node whose `turn-error` key belongs to dsh itself
 * (`packages/client/ui-chat/src/client/chat/register-node-renderers.ts:41`),
 * and a second registration under an occupied key throws. `conversation.input.dock`
 * is a list seat with a stable published contract
 * (`packages/client/ui-conversation/src/client/contract/slots.ts:127`), it
 * takes any number of registrants, and — the part that actually matters on a
 * phone — it is pinned above the composer instead of somewhere up the
 * scrollback the user has to go find.
 *
 * TWO THINGS KEEP IT INSIDE THE PAGE. A provider's failure message is not a
 * field anyone here controls: a rejected request body or an HTML error page
 * arrives as one enormous string, and the banner used to grow to fit it in both
 * directions.
 *
 * - WIDTH is not the text's fault at all. A dock entry that states no width of
 *   its own stretches to the entire conversation column, which is wider than
 *   the input card and wider still than the transcript. So the banner now
 *   restates dsh's shared width axis exactly the way dsh's own dock entries do
 *   — see {@link bannerStyle}.
 * - HEIGHT is the text's fault. The message gets a container of its own with a
 *   hard `maxHeight` and its own scrollbar, every box in the column carries
 *   `minWidth: 0`, and the buttons sit on the title row where their position
 *   does not depend on how long the message is. The Host clamps the string as
 *   well (`MESSAGE_LIMIT`), because scrolling a megabyte is not a feature
 *   either.
 *
 * The banner reads one host-computed value and owns no state beyond the click
 * in flight: `useProjection('turnRetry')` is fed by the Host fold, so a reload,
 * a reconnect, or a phone that was asleep all still show the same banner.
 *
 * @module @dsh-remote/dsh-plugin-turn-retry/client/RetryDock
 */

import { useCallback, useEffect, useState } from 'react'
import type { CSSProperties } from 'react'
import type { RetryResult, TurnRetryState } from '../shared.js'
import { fill } from './locales.js'
import type { RetryKey } from './locales.js'

/** What this plugin injects into its own registration. */
export interface RetryDockInjected {
  /** Ask the Host to re-drive this session's unfinished turn. */
  onRetry: () => Promise<RetryResult>
}

/** Copy key reporting each refusal the Host can answer with. */
const REFUSAL_KEYS = {
  busy: 'busy',
  'not-failed': 'notFailed',
  'no-agent': 'noAgent',
  subagent: 'subagent',
} as const satisfies Record<NonNullable<RetryResult['reason']>, RetryKey>

/**
 * dsh's own dock-card geometry, copied deliberately.
 *
 * `conversation.input.dock` entries are children of a plain column flex stack
 * (`ui-conversation/src/client/skeleton/ConversationRoot.module.css:281-289`),
 * so an entry with no width of its own stretches to the WHOLE conversation
 * column — wider than the input card by two 16px clearances and wider than the
 * transcript's text column on top of that. That is why this banner used to
 * stick out past the messages. dsh's own two entries solve it by restating the
 * shared width axis, and this is `TodoPanel.module.css:1-21` verbatim: the
 * column minus both side clearances and four dock insets, capped at the card
 * width minus four insets, centred with `margin: 0 auto`. The fallbacks are the
 * same numbers `.root` declares (`:32-34`) for the case where a future dsh
 * renames the variables — a banner one inset too wide beats a banner as wide as
 * the window.
 */
const CLEARANCE = 'var(--dsh-composer-side-clearance, 16px)'
const INSET = 'var(--dsh-composer-dock-inset, 8px)'
const CARD_MAX = 'var(--dsh-composer-card-max-width, 952px)'

const bannerStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '6px',
  flex: 'none',
  margin: '0 auto',
  width: `calc(100% - ${CLEARANCE} * 2 - ${INSET} * 4)`,
  maxWidth: `calc(${CARD_MAX} - ${INSET} * 4)`,
  minWidth: 0,
  boxSizing: 'border-box',
  padding: '8px 12px',
  borderRadius: '10px',
  border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3))',
  background: 'var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.08))',
  fontSize: '13px',
  lineHeight: 1.5,
}

const headerRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  flexWrap: 'wrap',
  minWidth: 0,
}

const titleStyle: CSSProperties = {
  fontWeight: 600,
  flex: '1 1 auto',
  minWidth: 0,
  overflowWrap: 'anywhere',
}

/**
 * The failure text's own scroll container.
 *
 * `maxHeight` is in `em` so it tracks the reader's font size: about six lines
 * either way. `overscrollBehavior: contain` keeps a flick inside the box from
 * scrolling the transcript behind it once it hits the end — the mobile failure
 * mode this whole box exists to avoid.
 *
 * The tint is a literal neutral rather than a `--dsw-alias-bg-layer-*` token on
 * purpose: in dsh's light palette layers 1-3 are all the same white
 * (`ui-theme/src/styles/design-platform.css:158-160`), so a layer token would
 * make this box invisible against the banner in exactly half the themes. A
 * translucent grey darkens a light surface and lightens a dark one.
 */
const messageBoxStyle: CSSProperties = {
  maxHeight: '7.5em',
  overflowY: 'auto',
  overflowX: 'hidden',
  overscrollBehavior: 'contain',
  padding: '6px 8px',
  borderRadius: '8px',
  border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3))',
  background: 'rgba(128,128,128,0.1)',
  color: 'var(--dsw-alias-label-secondary, #6b7280)',
  fontFamily: 'var(--dsw-font-mono, ui-monospace, monospace)',
  fontSize: '12px',
  lineHeight: 1.5,
  // Provider messages carry their own newlines, and a stack trace or a JSON
  // blob has no spaces to break at.
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
  minWidth: 0,
  maxWidth: '100%',
  boxSizing: 'border-box',
}

const hintStyle: CSSProperties = {
  color: 'var(--dsw-alias-label-secondary, #6b7280)',
  fontSize: '12px',
  minWidth: 0,
  overflowWrap: 'anywhere',
}

const errorStyle: CSSProperties = {
  color: 'var(--dsw-alias-state-error-primary, #dc2626)',
  fontSize: '12px',
  minWidth: 0,
  overflowWrap: 'anywhere',
}

const buttonStyle: CSSProperties = {
  padding: '5px 12px',
  borderRadius: '8px',
  border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3))',
  background: 'transparent',
  color: 'inherit',
  cursor: 'pointer',
  font: 'inherit',
  whiteSpace: 'nowrap',
  flex: '0 0 auto',
}

const primaryButtonStyle: CSSProperties = {
  ...buttonStyle,
  border: '1px solid transparent',
  background: 'var(--dsw-alias-button-primary-fill, #1f2937)',
  color: 'var(--dsw-alias-label-primary-inverted, #fff)',
}

/** Everything the banner reads. */
export interface RetryDockOwnProps {
  /** The unfinished turn the Host is reporting for this session, if any. */
  pending: TurnRetryState | undefined
  /** Whether the session is currently running a turn. */
  running: boolean
  /** Ask the Host to retry; absent before the registration binds. */
  onRetry?: RetryDockInjected['onRetry'] | undefined
  /** Locale seat bound to this plugin's namespace. */
  t?: ((key: RetryKey) => string) | undefined
}

/**
 * The banner body, free of any slot plumbing so tests can render it directly.
 * @param props - the pending turn, the session's run state, and the retry verb.
 * @returns the banner, or nothing when there is nothing to pick up.
 */
export function RetryBanner({ pending, running, onRetry, t }: RetryDockOwnProps) {
  const translate = useCallback((key: RetryKey): string => t?.(key) ?? key, [t])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // A turn the user chose not to act on stays out of the way, but only that
  // one: a later turn ending badly is a new decision, so the dismissal is keyed
  // by turn rather than being a sticky preference.
  const [dismissedTurn, setDismissedTurn] = useState<number | null>(null)

  const turn = pending?.turn
  useEffect(() => {
    setError(null)
    setBusy(false)
  }, [turn])

  const retry = useCallback(() => {
    if (onRetry === undefined) return
    setBusy(true)
    setError(null)
    void (async () => {
      try {
        const result = await onRetry()
        // A started retry is not settled here: the Host's `turn/start` clears
        // the projection, which unmounts this banner. Only a refusal has to be
        // shown.
        if (result.started) return
        const key = result.reason === undefined ? 'failed' : REFUSAL_KEYS[result.reason]
        setError(translate(key))
      } catch (cause: unknown) {
        setError(fill(translate('failed'), {
          message: cause instanceof Error ? cause.message : String(cause),
        }))
      } finally {
        setBusy(false)
      }
    })()
  }, [onRetry, translate])

  if (pending === null || pending === undefined) return null
  if (running) return null
  if (dismissedTurn === pending.turn) return null

  const failed = pending.kind === 'failed'
  const title = failed
    ? 'title'
    : pending.cause === 'user' ? 'stoppedTitle' : 'interruptedTitle'
  // A stop is picked up, not retried: "重试" would suggest re-running something
  // that went wrong, and nothing went wrong.
  const action = failed ? (busy ? 'retrying' : 'retry') : (busy ? 'resuming' : 'resume')

  return (
    <div style={bannerStyle} role="status">
      <div style={headerRowStyle}>
        <span style={titleStyle}>{translate(title)}</span>
        <button
          type="button"
          style={primaryButtonStyle}
          disabled={busy || onRetry === undefined}
          onClick={retry}
        >
          {translate(action)}
        </button>
        <button
          type="button"
          style={buttonStyle}
          disabled={busy}
          onClick={() => { setDismissedTurn(pending.turn) }}
        >
          {translate('dismiss')}
        </button>
      </div>
      {pending.kind === 'failed' && (
        <div style={messageBoxStyle} data-turn-retry="reason">
          {fill(translate('reason'), { code: pending.code, message: pending.message })}
        </div>
      )}
      {pending.kind === 'failed' && !pending.retryable && (
        <span style={hintStyle}>{translate('hopeless')}</span>
      )}
      {pending.kind === 'stopped' && <span style={hintStyle}>{translate('stoppedHint')}</span>}
      {error !== null && <span style={errorStyle}>{error}</span>}
    </div>
  )
}
