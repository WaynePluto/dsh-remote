/**
 * The collapsible services panel, rendered above the composer.
 *
 * WHY IT POLLS, and why that is not laziness. dsh has exactly one Host→Client
 * push seam — session projections — and this plugin cannot use it: a projection
 * folds session events, a plugin cannot append its own event type without
 * permanently breaking the session log (see `../shared.ts`), and even if it
 * could, a fold reports what this plugin last DID rather than what the
 * operating system currently HAS. Services exit on their own. So the page asks,
 * the Host reconciles against the OS, and the answer is true at the moment it
 * is given.
 *
 * The poll is written to be cheap on a phone over a relay, which is this
 * repository's whole reason to exist:
 *
 * - It stops entirely while the tab is hidden, and refreshes once on becoming
 *   visible again. A backgrounded phone costs nothing.
 * - Uptime ticks LOCALLY off one Host timestamp, so the seconds move every
 *   second while the network is touched every {@link POLL_MS}.
 * - The payload is a handful of short strings.
 *
 * WHY UPTIME USES THE HOST CLOCK. `ServicesSnapshot.now` is the Host's own
 * `Date.now()` at snapshot time. Rendering `Date.now() - startedAt` in the page
 * instead would subtract a timestamp taken on the dev machine from one taken on
 * the phone — which is wrong by however far the two clocks disagree, and phones
 * that have been asleep are routinely off by minutes.
 *
 * @module @dsh-remote/dsh-plugin-services/client/ServicesDock
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { formatUptime } from '../shared.js'
import type { ServiceActionResult, ServiceLogsResult, ServiceView, ServicesSnapshot } from '../shared.js'
import { fill } from './locales.js'
import type { ServicesKey } from './locales.js'

/** How often the panel refreshes while the tab is visible, in milliseconds. */
export const POLL_MS = 5000

/** How often the locally rendered uptime advances, in milliseconds. */
const TICK_MS = 1000

/** What this plugin injects into its own registration. */
export interface ServicesDockInjected {
  /** Ask the Host for a freshly reconciled snapshot. */
  onList: () => Promise<ServicesSnapshot>
  /** Ask the Host to stop one service. */
  onStop: (name: string) => Promise<ServiceActionResult>
  /** Ask the Host to restart one service with its recorded command. */
  onRestart: (name: string) => Promise<ServiceActionResult>
  /** Ask the Host for one service's log tail. */
  onLogs: (name: string) => Promise<ServiceLogsResult>
}

/**
 * dsh's own dock-card geometry, copied deliberately.
 *
 * `conversation.input.dock` entries are children of a plain column flex stack,
 * so an entry with no width of its own stretches to the WHOLE conversation
 * column — wider than the input card by two side clearances and wider than the
 * transcript's text column on top of that. dsh's own entries solve it by
 * restating the shared width axis, and this is that axis: the column minus both
 * side clearances and four dock insets, capped at the card width minus four
 * insets, centred. The fallbacks are the numbers dsh's own `.root` declares, so
 * a future dsh renaming a variable costs one inset of width rather than the
 * whole window.
 */
const CLEARANCE = 'var(--dsh-composer-side-clearance, 16px)'
const INSET = 'var(--dsh-composer-dock-inset, 8px)'
const CARD_MAX = 'var(--dsh-composer-card-max-width, 952px)'

/**
 * ⚠️ Theme tokens are spelled exactly as dsh defines them. A misspelt custom
 * property does not warn — it silently falls back to the literal after the
 * comma — so `--dsw-alias-border-l1` is an L, not a 1, and the mono family is
 * `--dsw-font-mono` (docs/02 §8.6).
 */
const BORDER = 'var(--dsw-alias-border-l1, rgba(128,128,128,0.3))'
const SECONDARY = 'var(--dsw-alias-label-secondary, #6b7280)'

const rootStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  flex: 'none',
  margin: '0 auto',
  width: `calc(100% - ${CLEARANCE} * 2 - ${INSET} * 4)`,
  maxWidth: `calc(${CARD_MAX} - ${INSET} * 4)`,
  minWidth: 0,
  boxSizing: 'border-box',
  borderRadius: '10px',
  border: `1px solid ${BORDER}`,
  // Opaque, not a layer token: in dsh's light palette layers 1-3 are the same
  // white, so a layer token would make this box invisible in half the themes.
  background: 'var(--dsw-alias-bg-base, transparent)',
  fontSize: '13px',
  lineHeight: 1.5,
  overflow: 'hidden',
}

const headerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  width: '100%',
  padding: '7px 12px',
  border: 'none',
  background: 'transparent',
  color: 'inherit',
  font: 'inherit',
  textAlign: 'left',
  cursor: 'pointer',
  minWidth: 0,
  boxSizing: 'border-box',
}

const titleStyle: CSSProperties = { fontWeight: 600, flex: '0 0 auto' }

const summaryStyle: CSSProperties = {
  color: SECONDARY,
  flex: '1 1 auto',
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

const listStyle: CSSProperties = {
  listStyle: 'none',
  margin: 0,
  padding: '0 12px 8px',
  display: 'flex',
  flexDirection: 'column',
  gap: '6px',
  minWidth: 0,
}

const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  flexWrap: 'wrap',
  minWidth: 0,
}

const nameStyle: CSSProperties = {
  fontFamily: 'var(--dsw-font-mono, ui-monospace, monospace)',
  fontWeight: 600,
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  maxWidth: '40%',
}

const factsStyle: CSSProperties = {
  color: SECONDARY,
  fontSize: '12px',
  flex: '1 1 auto',
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

const buttonStyle: CSSProperties = {
  padding: '2px 9px',
  borderRadius: '7px',
  border: `1px solid ${BORDER}`,
  background: 'transparent',
  color: 'inherit',
  cursor: 'pointer',
  font: 'inherit',
  fontSize: '12px',
  whiteSpace: 'nowrap',
  flex: '0 0 auto',
}

const logBoxStyle: CSSProperties = {
  maxHeight: '12em',
  overflowY: 'auto',
  overflowX: 'auto',
  // Keeps a flick that reaches the end of this box from scrolling the
  // transcript behind it — the mobile failure mode a nested scroller creates.
  overscrollBehavior: 'contain',
  margin: '2px 0 0',
  padding: '6px 8px',
  borderRadius: '8px',
  border: `1px solid ${BORDER}`,
  background: 'rgba(128,128,128,0.1)',
  color: SECONDARY,
  fontFamily: 'var(--dsw-font-mono, ui-monospace, monospace)',
  fontSize: '11px',
  lineHeight: 1.45,
  whiteSpace: 'pre',
  minWidth: 0,
  maxWidth: '100%',
  boxSizing: 'border-box',
}

const errorStyle: CSSProperties = {
  color: 'var(--dsw-alias-state-error-primary, #dc2626)',
  fontSize: '12px',
  minWidth: 0,
  overflowWrap: 'anywhere',
}

const warnStyle: CSSProperties = { ...errorStyle, color: SECONDARY }

/** Everything the panel reads. */
export interface ServicesPanelProps {
  /** The session this panel belongs to; a change resets everything. */
  sessionId: string | undefined
  /** The Host verbs, absent before the registration binds. */
  actions?: Partial<ServicesDockInjected> | undefined
  /** Locale seat bound to this plugin's namespace. */
  t?: ((key: ServicesKey) => string) | undefined
}

/** One row's transient state. */
type Busy = 'stop' | 'restart' | undefined

/**
 * Whether the document is currently visible.
 *
 * Guarded because the browser half is also imported by unit tests, where
 * `document` may be absent; treating that as "visible" keeps a test's first
 * fetch happening.
 * @returns whether polling should run.
 */
function documentVisible(): boolean {
  return typeof document === 'undefined' || document.visibilityState !== 'hidden'
}

/**
 * The panel body, free of slot plumbing so tests can render it directly.
 * @param props - the session, the Host verbs, and the locale seat.
 * @returns the panel, or nothing when this project has no services at all.
 */
export function ServicesPanel({ sessionId, actions, t }: ServicesPanelProps) {
  const translate = useCallback((key: ServicesKey): string => t?.(key) ?? key, [t])
  const [collapsed, setCollapsed] = useState(true)
  const [snapshot, setSnapshot] = useState<ServicesSnapshot | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<Record<string, Busy>>({})
  const [openLog, setOpenLog] = useState<string | null>(null)
  const [log, setLog] = useState<ServiceLogsResult | null>(null)
  /**
   * Local clock offset: `receivedAt` is when THIS page got the snapshot, so
   * uptime is `snapshot.now - startedAt + (localNow - receivedAt)`. That mixes
   * one absolute Host measurement with one purely local elapsed measurement and
   * never subtracts across the two machines' clocks.
   */
  const [receivedAt, setReceivedAt] = useState(() => Date.now())
  const [localNow, setLocalNow] = useState(() => Date.now())

  const onList = actions?.onList
  // A ref keeps the poll effect from being torn down and restarted every time
  // a fetch lands: the effect depends on the verb, not on the data.
  const listRef = useRef(onList)
  listRef.current = onList

  const load = useCallback(async (): Promise<void> => {
    const fetchList = listRef.current
    if (fetchList === undefined) return
    try {
      const next = await fetchList()
      setSnapshot(next)
      setReceivedAt(Date.now())
      setLocalNow(Date.now())
      setError(null)
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [])

  // Poll while visible; stop while hidden and catch up on return.
  useEffect(() => {
    if (sessionId === undefined) return
    let timer: ReturnType<typeof setInterval> | undefined
    const start = (): void => {
      if (timer !== undefined) return
      void load()
      timer = setInterval(() => { void load() }, POLL_MS)
    }
    const stop = (): void => {
      if (timer === undefined) return
      clearInterval(timer)
      timer = undefined
    }
    const onVisibility = (): void => {
      if (documentVisible()) start()
      else stop()
    }
    if (documentVisible()) start()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [sessionId, load])

  // A different session is a different project: drop everything rather than
  // showing the previous project's services until the first poll lands.
  useEffect(() => {
    setSnapshot(undefined)
    setError(null)
    setOpenLog(null)
    setLog(null)
    setBusy({})
  }, [sessionId])

  // Advance the rendered uptime without touching the network.
  useEffect(() => {
    if (collapsed || snapshot === undefined || snapshot.services.length === 0) return
    const timer = setInterval(() => { setLocalNow(Date.now()) }, TICK_MS)
    return () => { clearInterval(timer) }
  }, [collapsed, snapshot])

  const act = useCallback((name: string, kind: 'stop' | 'restart'): void => {
    const verb = kind === 'stop' ? actions?.onStop : actions?.onRestart
    if (verb === undefined) return
    setBusy(previous => ({ ...previous, [name]: kind }))
    setError(null)
    void (async () => {
      try {
        const result = await verb(name)
        // A refusal is a normal outcome the Host words carefully; show it as-is
        // rather than inventing a second vocabulary for it in the page.
        if (!result.ok) setError(result.message)
        await load()
      } catch (cause: unknown) {
        setError(fill(translate('failed'), {
          message: cause instanceof Error ? cause.message : String(cause),
        }))
      } finally {
        setBusy(previous => ({ ...previous, [name]: undefined }))
      }
    })()
  }, [actions, load, translate])

  const toggleLog = useCallback((name: string): void => {
    if (openLog === name) {
      setOpenLog(null)
      setLog(null)
      return
    }
    setOpenLog(name)
    setLog(null)
    const fetchLogs = actions?.onLogs
    if (fetchLogs === undefined) return
    void (async () => {
      try {
        setLog(await fetchLogs(name))
      } catch (cause: unknown) {
        setError(fill(translate('failed'), {
          message: cause instanceof Error ? cause.message : String(cause),
        }))
      }
    })()
  }, [actions, openLog, translate])

  const services: readonly ServiceView[] = snapshot?.services ?? []
  const stoppedLogs = snapshot?.stoppedLogs ?? []

  const summary = useMemo(() => {
    const parts: string[] = []
    parts.push(services.length === 0
      ? translate('summaryNone')
      : fill(translate('summaryRunning'), { count: services.length }))
    if (stoppedLogs.length > 0) {
      parts.push(fill(translate('summaryStopped'), { count: stoppedLogs.length }))
    }
    return parts.join(' · ')
  }, [services.length, stoppedLogs.length, translate])

  // Nothing has ever run in this project: no panel at all. A permanently empty
  // box above the composer would cost every user vertical space to tell them
  // about a feature they are not using.
  if (services.length === 0 && stoppedLogs.length === 0) return null

  const elapsed = (service: ServiceView): string => {
    if (snapshot === undefined) return ''
    return formatUptime(snapshot.now - service.startedAt + (localNow - receivedAt))
  }

  return (
    <section style={rootStyle} aria-label={translate('title')} data-dsh-services-panel="">
      <button
        type="button"
        style={headerStyle}
        aria-expanded={!collapsed}
        onClick={() => { setCollapsed(value => !value) }}
      >
        <span style={titleStyle}>{translate('title')}</span>
        <span style={summaryStyle}>{summary}</span>
        <span aria-hidden style={{ color: SECONDARY, flex: '0 0 auto' }}>{collapsed ? '▾' : '▴'}</span>
      </button>

      {!collapsed && (
        <ul style={listStyle}>
          {services.map(service => (
            <li key={service.name} style={{ minWidth: 0 }}>
              <div style={rowStyle}>
                <span style={nameStyle} title={service.command}>{service.name}</span>
                <span style={factsStyle}>
                  {[
                    service.port === undefined ? undefined : `:${String(service.port)}`,
                    `pid ${String(service.pid)}`,
                    elapsed(service),
                    service.command,
                  ].filter(Boolean).join('  ')}
                </span>
                <button
                  type="button"
                  style={buttonStyle}
                  disabled={busy[service.name] !== undefined}
                  onClick={() => { toggleLog(service.name) }}
                >
                  {openLog === service.name ? translate('hideLogs') : translate('logs')}
                </button>
                <button
                  type="button"
                  style={buttonStyle}
                  disabled={busy[service.name] !== undefined || actions?.onRestart === undefined}
                  onClick={() => { act(service.name, 'restart') }}
                >
                  {busy[service.name] === 'restart' ? translate('restarting') : translate('restart')}
                </button>
                <button
                  type="button"
                  style={buttonStyle}
                  disabled={busy[service.name] !== undefined || actions?.onStop === undefined}
                  onClick={() => { act(service.name, 'stop') }}
                >
                  {busy[service.name] === 'stop' ? translate('stopping') : translate('stop')}
                </button>
              </div>
              {service.identity === 'unknown' && (
                <div style={warnStyle}>{translate('unknownIdentity')}</div>
              )}
              {openLog === service.name && (
                <div style={logBoxStyle}>
                  {log === null
                    ? translate('loadingLogs')
                    : log.tail === '' ? translate('emptyLog') : log.tail}
                </div>
              )}
            </li>
          ))}
          {stoppedLogs.length > 0 && (
            <li style={{ ...warnStyle, minWidth: 0 }}>
              {fill(translate('stoppedHint'), { names: stoppedLogs.join('、') })}
            </li>
          )}
          {error !== null && <li style={errorStyle}>{error}</li>}
        </ul>
      )}
    </section>
  )
}
