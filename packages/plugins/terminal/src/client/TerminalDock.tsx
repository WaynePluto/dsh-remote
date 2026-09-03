/**
 * The collapsible terminal panel, rendered above the composer.
 *
 * WHY IT POLLS. dsh's one Host→Client push seam is session projections, and the
 * three PTY packages publish none — no projection, no event, nothing appended
 * to the session log (see `../shared.ts`). So the page asks. The cost is kept
 * where a phone on a relay can afford it:
 *
 * - The session list is polled slowly ({@link LIST_POLL_MS}); the screen is
 *   polled quickly ({@link SCREEN_POLL_MS}) and ONLY while the panel is open.
 * - The screen poll carries the last `revision`, so an idle terminal answers
 *   with one short string instead of a screen.
 * - Everything stops while the tab is hidden and catches up on return.
 *
 * WHY THE DRAFT SURVIVES A REFUSAL. `ctx.terminals` allows exactly one active
 * send and throws on the second, so a keystroke can bounce. The Host waits out
 * that window and, if it still cannot deliver, says so with `busy: true` — and
 * this panel then KEEPS what was typed. Silently clearing an input box that
 * just swallowed a password is the one failure this component must not have.
 *
 * @module @dsh-remote/dsh-plugin-terminal/client/TerminalDock
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent } from 'react'
import { terminalLabel } from '../shared.js'
import type {
  TerminalReadResultView, TerminalSendResultView, TerminalView, TerminalsSnapshot,
} from '../shared.js'
import { fill } from './locales.js'
import type { TerminalKey } from './locales.js'

/** How often the session list refreshes while the tab is visible, in ms. */
export const LIST_POLL_MS = 5000

/** How often the open panel refreshes the screen, in ms. */
export const SCREEN_POLL_MS = 1500

/** How long the panel refreshes fast after the user sent something, in ms. */
const EAGER_WINDOW_MS = 4000

/** The fast cadence used inside {@link EAGER_WINDOW_MS}. */
const EAGER_POLL_MS = 400

/** What this plugin injects into its own registration. */
export interface TerminalDockInjected {
  /** Ask the Host which terminals this conversation's agent owns. */
  onList: () => Promise<TerminalsSnapshot>
  /** Ask the Host for one terminal's screen, skipping an unchanged one. */
  onRead: (terminalId: string, revision: string | undefined) => Promise<TerminalReadResultView>
  /** Ask the Host to write the user's keystrokes into one terminal. */
  onSend: (terminalId: string, text: string, submit: boolean) => Promise<TerminalSendResultView>
  /** Ask the Host to SIGINT one terminal's foreground process group. */
  onInterrupt: (terminalId: string) => Promise<TerminalSendResultView>
}

/**
 * dsh's own dock-card geometry, copied deliberately.
 *
 * `conversation.input.dock` entries are children of a plain column flex stack,
 * so an entry with no width of its own stretches to the WHOLE conversation
 * column — wider than the input card by two side clearances. dsh's own entries
 * solve it by restating the shared width axis, and this is that axis.
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
const MONO = 'var(--dsw-font-mono, ui-monospace, monospace)'

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

const bodyStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '6px',
  padding: '0 12px 10px',
  minWidth: 0,
}

const tabsStyle: CSSProperties = {
  display: 'flex',
  gap: '6px',
  flexWrap: 'wrap',
  minWidth: 0,
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

const activeTabStyle: CSSProperties = {
  ...buttonStyle,
  fontFamily: MONO,
  // Neutral translucent grey rather than a layer token, for the same reason the
  // root background is opaque: the light palette's layers are one colour.
  background: 'rgba(128,128,128,0.18)',
}

const screenStyle: CSSProperties = {
  maxHeight: '18em',
  overflowY: 'auto',
  overflowX: 'auto',
  // Keeps a flick that reaches the end of this box from scrolling the
  // transcript behind it — the mobile failure mode a nested scroller creates.
  overscrollBehavior: 'contain',
  margin: 0,
  padding: '6px 8px',
  borderRadius: '8px',
  border: `1px solid ${BORDER}`,
  background: 'rgba(128,128,128,0.1)',
  fontFamily: MONO,
  fontSize: '11px',
  lineHeight: 1.45,
  whiteSpace: 'pre',
  minWidth: 0,
  maxWidth: '100%',
  boxSizing: 'border-box',
}

const inputRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '6px',
  minWidth: 0,
}

const inputStyle: CSSProperties = {
  flex: '1 1 auto',
  minWidth: 0,
  padding: '4px 8px',
  borderRadius: '7px',
  border: `1px solid ${BORDER}`,
  background: 'transparent',
  color: 'inherit',
  font: 'inherit',
  fontFamily: MONO,
  fontSize: '12px',
}

const noteStyle: CSSProperties = {
  color: SECONDARY,
  fontSize: '12px',
  minWidth: 0,
  overflowWrap: 'anywhere',
}

const errorStyle: CSSProperties = {
  ...noteStyle,
  color: 'var(--dsw-alias-state-error-primary, #dc2626)',
}

/** Everything the panel reads. */
export interface TerminalPanelProps {
  /** The conversation this panel belongs to; a change resets everything. */
  sessionId: string | undefined
  /** The Host verbs, absent before the registration binds. */
  actions?: Partial<TerminalDockInjected> | undefined
  /** Locale seat bound to this plugin's namespace. */
  t?: ((key: TerminalKey) => string) | undefined
}

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
 * @param props - the conversation, the Host verbs, and the locale seat.
 * @returns the panel, or nothing when this conversation owns no terminals.
 */
export function TerminalPanel({ sessionId, actions, t }: TerminalPanelProps) {
  const translate = useCallback((key: TerminalKey): string => t?.(key) ?? key, [t])
  const [collapsed, setCollapsed] = useState(true)
  const [snapshot, setSnapshot] = useState<TerminalsSnapshot | undefined>(undefined)
  const [selected, setSelected] = useState<string | undefined>(undefined)
  const [screen, setScreen] = useState<TerminalReadResultView | undefined>(undefined)
  const [draft, setDraft] = useState('')
  const [note, setNote] = useState<{ text: string, bad: boolean } | undefined>(undefined)
  const [pending, setPending] = useState<'send' | 'interrupt' | undefined>(undefined)
  const [eagerUntil, setEagerUntil] = useState(0)

  const screenRef = useRef<HTMLPreElement | null>(null)
  const followRef = useRef(true)
  // Refs keep the poll effects from being torn down and restarted every time a
  // response lands: an effect depends on the verb, not on the data.
  const listRef = useRef(actions?.onList)
  listRef.current = actions?.onList
  const readRef = useRef(actions?.onRead)
  readRef.current = actions?.onRead
  const revisionRef = useRef<string | undefined>(undefined)

  const terminals: readonly TerminalView[] = useMemo(() => snapshot?.terminals ?? [], [snapshot])

  const loadList = useCallback(async (): Promise<void> => {
    const fetchList = listRef.current
    if (fetchList === undefined) return
    try {
      setSnapshot(await fetchList())
    } catch (cause: unknown) {
      setNote({ text: fill(translate('failed'), { message: describe(cause) }), bad: true })
    }
  }, [translate])

  const loadScreen = useCallback(async (terminalId: string): Promise<void> => {
    const fetchScreen = readRef.current
    if (fetchScreen === undefined) return
    try {
      const next = await fetchScreen(terminalId, revisionRef.current)
      revisionRef.current = next.revision
      // An unchanged answer carries no text on purpose; keeping the previous
      // screen is the whole point of asking with a revision.
      if (!next.unchanged) setScreen(next)
      else setScreen(previous => previous === undefined ? next : { ...previous, running: next.running })
    } catch (cause: unknown) {
      setNote({ text: fill(translate('failed'), { message: describe(cause) }), bad: true })
    }
  }, [translate])

  // Poll the session list while visible; stop while hidden and catch up.
  useEffect(() => {
    if (sessionId === undefined) return
    let timer: ReturnType<typeof setInterval> | undefined
    const start = (): void => {
      if (timer !== undefined) return
      void loadList()
      timer = setInterval(() => { void loadList() }, LIST_POLL_MS)
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
  }, [sessionId, loadList])

  // A different conversation is a different agent, and therefore different
  // terminals: drop everything rather than showing the previous one's screen.
  useEffect(() => {
    setSnapshot(undefined)
    setSelected(undefined)
    setScreen(undefined)
    setDraft('')
    setNote(undefined)
    revisionRef.current = undefined
  }, [sessionId])

  // Keep a valid selection without ever silently switching the user away from
  // the terminal they are typing into.
  useEffect(() => {
    if (terminals.length === 0) {
      if (selected !== undefined) setSelected(undefined)
      return
    }
    if (selected !== undefined && terminals.some(entry => entry.id === selected)) return
    setSelected(terminals[terminals.length - 1]?.id)
    setScreen(undefined)
    revisionRef.current = undefined
  }, [terminals, selected])

  // Poll the screen only while the panel is open: a collapsed panel showing one
  // summary line has no use for 1.5-second screen fetches.
  useEffect(() => {
    if (collapsed || selected === undefined) return
    let timer: ReturnType<typeof setTimeout> | undefined
    let stopped = false
    const tick = (): void => {
      if (stopped) return
      void loadScreen(selected)
      timer = setTimeout(tick, Date.now() < eagerUntil ? EAGER_POLL_MS : SCREEN_POLL_MS)
    }
    const onVisibility = (): void => {
      if (!documentVisible() || stopped) return
      if (timer !== undefined) clearTimeout(timer)
      tick()
    }
    if (documentVisible()) tick()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      stopped = true
      if (timer !== undefined) clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [collapsed, selected, eagerUntil, loadScreen])

  // Follow the output the way a terminal does, but stop following the moment
  // the user scrolls up to read something.
  useEffect(() => {
    const element = screenRef.current
    if (element === null || !followRef.current) return
    element.scrollTop = element.scrollHeight
  }, [screen])

  const onScroll = useCallback((): void => {
    const element = screenRef.current
    if (element === null) return
    followRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24
  }, [])

  const send = useCallback((text: string, submit: boolean): void => {
    const verb = actions?.onSend
    if (verb === undefined || selected === undefined) return
    setPending('send')
    setNote(undefined)
    void (async () => {
      try {
        const result = await verb(selected, text, submit)
        // ⚠️ Only a delivered send clears the box. A refusal — above all a busy
        // one — keeps what was typed, because the text never reached the shell
        // and re-typing a password nobody can read back is the worse outcome.
        if (result.ok) setDraft('')
        else setNote({ text: result.message, bad: true })
        followRef.current = true
        setEagerUntil(Date.now() + EAGER_WINDOW_MS)
      } catch (cause: unknown) {
        setNote({ text: fill(translate('failed'), { message: describe(cause) }), bad: true })
      } finally {
        setPending(undefined)
      }
    })()
  }, [actions, selected, translate])

  const interrupt = useCallback((): void => {
    const verb = actions?.onInterrupt
    if (verb === undefined || selected === undefined) return
    setPending('interrupt')
    setNote(undefined)
    void (async () => {
      try {
        const result = await verb(selected)
        setNote({ text: result.message, bad: !result.ok })
        setEagerUntil(Date.now() + EAGER_WINDOW_MS)
      } catch (cause: unknown) {
        setNote({ text: fill(translate('failed'), { message: describe(cause) }), bad: true })
      } finally {
        setPending(undefined)
      }
    })()
  }, [actions, selected, translate])

  const onKeyDown = useCallback((event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
    event.preventDefault()
    send(draft, true)
  }, [draft, send])

  const current = terminals.find(entry => entry.id === selected)

  const summary = useMemo(() => {
    if (current === undefined) return ''
    const state = current.sending
      ? translate('sending')
      : current.running
        ? translate('running')
        : current.exitCode === undefined || current.exitCode === null
          ? translate('exited')
          : fill(translate('exitedWithCode'), { code: current.exitCode })
    const label = `${terminalLabel(current)} · ${state}`
    return terminals.length === 1
      ? fill(translate('summaryOne'), { label })
      : fill(translate('summaryMany'), { count: terminals.length, label })
  }, [current, terminals.length, translate])

  // No terminal has ever been opened in this conversation: no panel at all. A
  // permanently empty box above the composer would cost every user vertical
  // space to tell them about a feature they are not using.
  if (terminals.length === 0) return null

  const body = screen === undefined
    ? translate('loading')
    : screen.text === '' ? translate('emptyScreen') : screen.text

  return (
    <section style={rootStyle} aria-label={translate('title')} data-dsh-terminal-panel="">
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
        <div style={bodyStyle}>
          {terminals.length > 1 && (
            <div style={tabsStyle} role="tablist">
              {terminals.map(entry => (
                <button
                  key={entry.id}
                  type="button"
                  role="tab"
                  aria-selected={entry.id === selected}
                  style={entry.id === selected ? activeTabStyle : { ...buttonStyle, fontFamily: MONO }}
                  onClick={() => {
                    if (entry.id === selected) return
                    setSelected(entry.id)
                    setScreen(undefined)
                    setNote(undefined)
                    revisionRef.current = undefined
                    followRef.current = true
                  }}
                >
                  {terminalLabel(entry)}
                </button>
              ))}
            </div>
          )}

          <pre ref={screenRef} style={screenStyle} onScroll={onScroll} data-dsh-terminal-screen="">
            {body}
          </pre>

          {current !== undefined && current.running
            ? (
                <div style={inputRowStyle}>
                  <input
                    style={inputStyle}
                    value={draft}
                    aria-label={translate('inputLabel')}
                    placeholder={translate('inputPlaceholder')}
                    disabled={pending !== undefined}
                    onChange={event => { setDraft(event.target.value) }}
                    onKeyDown={onKeyDown}
                  />
                  <button
                    type="button"
                    style={buttonStyle}
                    disabled={pending !== undefined || actions?.onSend === undefined}
                    onClick={() => { send(draft, true) }}
                  >
                    {draft === '' ? translate('sendEmpty') : translate('send')}
                  </button>
                  <button
                    type="button"
                    style={buttonStyle}
                    disabled={pending !== undefined || actions?.onInterrupt === undefined}
                    onClick={interrupt}
                  >
                    {pending === 'interrupt' ? translate('interrupting') : translate('interrupt')}
                  </button>
                </div>
              )
            : <div style={noteStyle}>{translate('exitedHint')}</div>}

          {note !== undefined && <div style={note.bad ? errorStyle : noteStyle}>{note.text}</div>}
          <div style={noteStyle}>{translate('hint')}</div>
        </div>
      )}
    </section>
  )
}

/**
 * One sentence for a thrown value.
 * @param cause - the thrown value.
 * @returns its message.
 */
function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
