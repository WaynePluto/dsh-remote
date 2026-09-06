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
// dsh's own primitives, taken from the page's frozen module table rather than
// bundled: the same `Modal` its dialogs use (mask, blur, Escape, body portal)
// and the same 14px icon language its dock panels use.
import { IconApiOutline14, IconChevronDownOutline14, IconChevronUpOutline14, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { formatUptime } from '../shared.js'
import type { ServiceActionResult, ServiceLogsResult, ServiceView, ServicesSnapshot } from '../shared.js'
import { LOG_DIALOG_CLASS, LOG_DIALOG_HEIGHT, LOG_PATH_MIN_HEIGHT_PX, logDialogRule, logDialogWidth, publishLogDialogWidth } from './log-dialog.js'
import { fill } from './locales.js'
import type { ServicesKey } from './locales.js'

/** How often the panel refreshes while the tab is visible, in milliseconds. */
export const POLL_MS = 5000

/** How often the locally rendered uptime advances, in milliseconds. */
const TICK_MS = 1000

/**
 * Install the log-dialog stylesheet.
 *
 * The rule text and the width arithmetic live in `./log-dialog.ts`, which stays
 * DOM-free so a unit test can assert them; only the two `document` calls are
 * here, where the browser program supplies the types.
 * @returns a disposer removing the stylesheet.
 */
function installLogDialogStyles(): () => void {
  const element = document.createElement('style')
  element.dataset['dshServicesLogDialog'] = ''
  element.textContent = logDialogRule()
  document.head.append(element)
  return () => { element.remove() }
}

/**
 * Publish the measured dialog width onto `<html>` for the stylesheet to read.
 * @param width - the dialog width in px.
 */
function publishWidth(width: number): void {
  publishLogDialogWidth(
    (name, value) => { document.documentElement.style.setProperty(name, value) },
    width,
  )
}


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
const TERTIARY = 'var(--dsw-alias-label-tertiary, #6b7280)'

/**
 * The card surface, taken from dsh's own todo panel rather than invented.
 *
 * `--dsw-specific-tip` is the ELEVATED surface rung — the same one dsh's menus
 * use — and it is deliberately NOT the page background:
 * `rgb(245,246,247)` in light, `rgb(53,54,56)` in dark
 * (`ui-theme/src/styles/design-platform.css:245,337`;
 * `ui-conversation/.../TodoPanel.module.css:24`).
 *
 * The first version used `--dsw-alias-bg-base`, which in the light palette is
 * plain white — so the card dissolved into the page and read as "太白了" next
 * to dsh's own todo strip. This is the same class of mistake as §8.6a: a
 * background that is technically a valid token but carries no elevation.
 *
 * The fallback is a neutral translucent grey rather than either literal: it
 * darkens a light surface and lightens a dark one, so if a future dsh renames
 * the token this degrades to a still-visible card in BOTH themes instead of
 * being right in one and invisible in the other.
 */
const SURFACE = 'var(--dsw-specific-tip, rgba(128,128,128,0.1))'

const rootStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  flex: 'none',
  margin: '0 auto',
  width: `calc(100% - ${CLEARANCE} * 2 - ${INSET} * 4)`,
  maxWidth: `calc(${CARD_MAX} - ${INSET} * 4)`,
  minWidth: 0,
  boxSizing: 'border-box',
  // 0.5px and 12px are dsh's own numbers for this card, not rounded versions:
  // sitting directly beside the todo panel, a 1px border and a 10px radius
  // read as a different component rather than a sibling.
  borderRadius: '12px',
  border: `0.5px solid ${BORDER}`,
  background: SURFACE,
  fontSize: '13px',
  lineHeight: 1.5,
  overflow: 'hidden',
}

/**
 * ⚠️ 表头对齐全部交给 flex，**不写任何固定尺寸**。
 *
 * dsh 自己的表头是 `lead`(14px svg) + 标题(line-height 24px) + 摘要(20px) +
 * chevron(14px)，靠 `align-items:center` 对齐 —— 它对齐的是**盒子中心**，而这四个
 * 盒子高度各不相同，图标的几何中心与文字 ink 的视觉中心就差出肉眼可见的一两像素
 * （用户实机反馈：icon / 标题 / 副标题竖直方向没对齐）。
 *
 * 这里的做法是两层 flex：
 * 1. 表头 `align-items: stretch` —— 四个块被拉成**同一高度**（由最高的内容决定，
 *    不是某个写死的数字）。
 * 2. 每个块自己 `display:flex; align-items:center` —— 图标 / 文字各自在这同一个
 *    高度里居中。
 *
 * 于是「居中」只依赖 flex 本身，既不依赖字体度量，也不需要谁去猜一个行高。
 * ⚠️ 摘要要省略号，就必须把文字放进**内层 span**：flex 容器自己做不了
 * `text-overflow: ellipsis`。
 */
const headerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'stretch',
  gap: '10px',
  width: '100%',
  padding: '8px 12px',
  border: 'none',
  background: 'transparent',
  color: 'inherit',
  font: 'inherit',
  textAlign: 'left',
  cursor: 'pointer',
  minWidth: 0,
  boxSizing: 'border-box',
}

/**
 * ⚠️ 图标的**光学**下移量，不是随手写的数字。
 *
 * flex 把图标格与文字格拉成等高、各自居中之后，量一张真实截图（`sharp` 读墨迹包
 * 围盒，1× 无缩放）：标题「常驻服务」与副标题「1 个运行中」的墨迹中心都落在
 * y=48.0，而图标的墨迹中心在 y=46.5 —— 图标高了 1.5px。原因是**几何居中不等于视
 * 觉居中**：汉字字面在行盒里天然偏下，svg 却是按几何中心摆的，这 1.5px 无论怎么
 * 调 flex 都补不回来。
 *
 * 所以补一次光学位移，写成 **em**（1.5px ÷ 13px ≈ 0.115em）而不是 px：字号变了它
 * 跟着变。用 `transform` 而不是 margin —— 纯视觉位移，不参与布局，不会把等高的格
 * 子挤歪。
 */
const GLYPH_OPTICAL_SHIFT = 'translateY(0.115em)'

/**
 * The header's leading glyph cell — centres the icon in the stretched row.
 *
 * `line-height: 0` 是这一格的最后一道保险：svg 作为 flex item 会被 blockify，但
 * 只要格子里出现任何文本节点（哪怕 JSX 里的一个空白），行盒的半行距就会把图标顶
 * 偏一两像素 —— 归零后这一格的高度只由 svg 自己决定。
 */
const leadStyle: CSSProperties = {
  display: 'flex',
  flex: 'none',
  alignItems: 'center',
  justifyContent: 'center',
  lineHeight: 0,
  transform: GLYPH_OPTICAL_SHIFT,
  color: 'var(--dsw-alias-label-tertiary, #6b7280)',
}

/** The disclosure chevron cell — the same centring and optical shift as the lead. */
const chevronStyle: CSSProperties = {
  display: 'flex',
  flex: 'none',
  alignItems: 'center',
  justifyContent: 'center',
  lineHeight: 0,
  transform: GLYPH_OPTICAL_SHIFT,
  color: TERTIARY,
}

const titleStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  flex: '0 0 auto',
  fontSize: '13px',
  fontWeight: 500,
  color: 'var(--dsw-alias-label-primary, inherit)',
  whiteSpace: 'nowrap',
}

const summaryStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  color: TERTIARY,
  fontSize: '13px',
  flex: '1 1 auto',
  minWidth: 0,
}

/** The summary's text box — the ellipsis lives here, not on the flex cell. */
const summaryTextStyle: CSSProperties = {
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
  gap: '8px',
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
  fontFamily: 'var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
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

/**
 * The log body inside the modal.
 *
 * ⚠️ The monospace fallback is a COMPLETE stack, not `ui-monospace, monospace`.
 * `--dsw-font-mono` is a name dsh references but never defines, so this
 * fallback is what actually renders — and on Windows `ui-monospace` does not
 * resolve, which would drop straight to the browser's default fixed font
 * (docs/02 §8.6b).
 */
const logBoxStyle: CSSProperties = {
  // FIXED, not a maximum: a maximum grew with the content, so the card opened
  // small on "loading…" and jumped to full size when the log landed. Still
  // clamped to the viewport — see LOG_DIALOG_HEIGHT for why that clamp is
  // load-bearing rather than cosmetic.
  height: LOG_DIALOG_HEIGHT,
  // `.body` is a flex column, so without this the fixed height would still be a
  // shrinkable flex base.
  flex: 'none',
  overflow: 'auto',
  overscrollBehavior: 'contain',
  margin: 0,
  padding: '10px 12px',
  borderRadius: '8px',
  border: `1px solid ${BORDER}`,
  background: 'rgba(128,128,128,0.1)',
  color: SECONDARY,
  fontFamily: 'var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
  fontSize: '12px',
  lineHeight: 1.5,
  whiteSpace: 'pre',
  minWidth: 0,
  boxSizing: 'border-box',
}

/**
 * The log file path shown above the body.
 *
 * The reserved height keeps the box present while the path is still unknown, so
 * the dialog does not gain a line when the Host answers; `nowrap` keeps a long
 * path from wrapping to a second line, which would be the same jump again. The
 * full path stays available through the element's `title`.
 */
const logPathStyle: CSSProperties = {
  fontFamily: 'var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
  fontSize: '11px',
  lineHeight: `${String(LOG_PATH_MIN_HEIGHT_PX)}px`,
  minHeight: `${String(LOG_PATH_MIN_HEIGHT_PX)}px`,
  color: TERTIARY,
  margin: '0 0 8px',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
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
  /** This card's own box — the ruler the log dialog is sized against. */
  const rootRef = useRef<HTMLElement | null>(null)

  // One stylesheet for the lifetime of the panel; the width itself travels as a
  // custom property, so opening a dialog never rebuilds this.
  useEffect(() => installLogDialogStyles(), [])

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

  /** Open the log dialog for one service, or refresh the one already open. */
  const showLog = useCallback((name: string): void => {
    // Measure now, not at mount: the column changes width when the sidebar
    // collapses or the user drags the width handles, and this is the moment the
    // number is actually needed.
    const measured = rootRef.current?.getBoundingClientRect().width ?? 0
    publishWidth(logDialogWidth(measured))
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
  }, [actions, translate])

  const closeLog = useCallback((): void => {
    setOpenLog(null)
    setLog(null)
  }, [])

  const services: readonly ServiceView[] = snapshot?.services ?? []

  const summary = useMemo(
    () => fill(translate('summaryRunning'), { count: services.length }),
    [services.length, translate],
  )

  // No running service means no panel at all — not even a "0 stopped" strip.
  // The dock sits between the transcript and the composer, so anything shown
  // there costs every user vertical space on every turn; a panel about
  // something that is not running has not earned it. A crashed service's log
  // stays readable through `service_logs`.
  if (services.length === 0) return null

  const elapsed = (service: ServiceView): string => {
    if (snapshot === undefined) return ''
    return formatUptime(snapshot.now - service.startedAt + (localNow - receivedAt))
  }

  return (
    <section ref={rootRef} style={rootStyle} aria-label={translate('title')} data-dsh-services-panel="">
      <button
        type="button"
        style={headerStyle}
        aria-expanded={!collapsed}
        onClick={() => { setCollapsed(value => !value) }}
      >
        {/* dsh's own 14px glyph set, matching the todo panel's lead icon. The
            API mark is a terminal prompt in a rounded square — which is
            literally what a service is here. */}
        <span aria-hidden style={leadStyle}><IconApiOutline14 /></span>
        <span style={titleStyle}>{translate('title')}</span>
        <span style={summaryStyle}><span style={summaryTextStyle}>{summary}</span></span>
        {/* dsh's shared disclosure chevron: collapsed points UP, expanded
            points DOWN (`TodoPanel.tsx:104-106`). A text "▾" was a different
            glyph at a different weight sitting right beside it. */}
        <span aria-hidden style={chevronStyle}>
          {collapsed ? <IconChevronUpOutline14 /> : <IconChevronDownOutline14 />}
        </span>
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
                  onClick={() => { showLog(service.name) }}
                >
                  {translate('logs')}
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
            </li>
          ))}
          {error !== null && <li style={errorStyle}>{error}</li>}
        </ul>
      )}

      {/* The log lives in dsh's own centred dialog rather than under the row:
          the dock strip is a few lines tall, and a dev server's output is not
          readable in it. `Modal` brings the mask, the blur, Escape-to-close and
          the body portal with it, so this cannot be clipped by the dock's
          `overflow: hidden`. */}
      <Modal
        open={openLog !== null}
        onClose={closeLog}
        className={LOG_DIALOG_CLASS}
        title={fill(translate('logTitle'), { name: openLog ?? '' })}
        closeLabel={translate('close')}
        footer={(
          <button
            type="button"
            style={buttonStyle}
            onClick={() => { if (openLog !== null) showLog(openLog) }}
          >
            {translate('refresh')}
          </button>
        )}
      >
        {/* Rendered even while `log` is null: the box holds its reserved height
            so the dialog does not grow a line when the path arrives. */}
        <div style={logPathStyle} title={log?.file ?? ''}>{log?.file ?? ''}</div>
        <pre style={logBoxStyle}>
          {log === null
            ? translate('loadingLogs')
            : log.tail === '' ? translate('emptyLog') : log.tail}
        </pre>
      </Modal>
    </section>
  )
}


