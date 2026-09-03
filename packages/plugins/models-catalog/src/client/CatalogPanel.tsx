/**
 * The models.dev panel, rendered at the foot of dsh's Models page.
 *
 * WHY THE FOOTER AND NOT EACH CARD. `settings.models.provider-card` is a keyed
 * seat with one entry per settings namespace, and our sibling `copilot-auth`
 * already occupies `llm-pi-ai` — a second registration under the same key
 * throws (`packages/client/ui-slots/src/index.ts`, keyed cell occupancy). The
 * footer is a list seat, so it takes any number of registrants, and one panel
 * listing every affected provider also reads better than the same button
 * repeated on every card.
 *
 * Styling uses dsh's own `--dsw-*` theme tokens with fallbacks, so the panel
 * follows light/dark without this package shipping a stylesheet.
 *
 * @module @dsh-remote/dsh-plugin-models-catalog/client/CatalogPanel
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type { CatalogStatusView, RoutePreview } from '../shared.js'
import { fill } from './locales.js'
import type { CatalogKey } from './locales.js'

/** How many model names are listed before the rest are summarized. */
const NAME_PREVIEW = 6

/** What this plugin injects into its own registration. */
export interface CatalogPanelInjected {
  /** Call one endpoint of this plugin's channel. */
  call: (endpoint: string, payload?: unknown) => Promise<CatalogStatusView>
}

/** Everything the component reads. */
export type CatalogPanelProps = Partial<CatalogPanelInjected> & {
  /** Locale seat bound to this plugin's namespace. */
  t?: (key: CatalogKey) => string
}

const panelStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '10px',
  marginTop: '16px',
  paddingTop: '14px',
  borderTop: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.2))',
  fontSize: '13px',
}

const titleStyle: CSSProperties = { fontWeight: 600 }

const rowStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }

const mutedStyle: CSSProperties = { color: 'var(--dsw-alias-label-secondary, #6b7280)' }

const routeStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '2px',
  padding: '8px 10px',
  borderRadius: '8px',
  background: 'var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.08))',
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

/** Copy key of a route's block reason. */
const BLOCK_KEYS = {
  'multi-protocol': 'blockedMultiProtocol',
  'no-source': 'blockedNoSource',
  'foreign-models': 'blockedForeign',
} as const satisfies Record<NonNullable<RoutePreview['blocked']>, CatalogKey>

/** A date as the page's own locale renders it, or an em dash when absent. */
function when(value: number | undefined): string {
  return value === undefined ? '—' : new Date(value).toLocaleDateString()
}

/** Whether a route has anything the human could act on. */
function actionable(route: RoutePreview): boolean {
  return route.additions.length > 0 || route.reclaimed.length > 0
}

/** Whether a route is worth a line at all. */
function interesting(route: RoutePreview): boolean {
  return actionable(route) || route.ownedIds.length > 0 || route.blocked === 'multi-protocol'
}

/**
 * One provider's line.
 * @param props - the route, the copy seat, and the selection controls.
 * @returns the line.
 */
function RouteLine(props: {
  route: RoutePreview
  t: (key: CatalogKey) => string
  selected: boolean
  onToggle: (route: string) => void
}): ReactNode {
  const { route, t, selected, onToggle } = props
  const names = route.additions.map(model => model.name)
  const shown = names.slice(0, NAME_PREVIEW).join(', ')
  const rest = names.length - Math.min(names.length, NAME_PREVIEW)
  const reasoning = route.additions.some(model => model.reasoningUnavailable === true)
  return (
    <div style={routeStyle}>
      <div style={rowStyle}>
        {actionable(route)
          ? (
            <input
              type="checkbox"
              checked={selected}
              aria-label={route.displayName}
              onChange={() => { onToggle(route.route) }}
            />
          )
          : null}
        <span style={{ fontWeight: 600 }}>{route.displayName}</span>
        {route.additions.length > 0
          ? <span>{fill(t('additions'), { count: route.additions.length })}</span>
          : null}
        {route.reclaimed.length > 0
          ? <span style={mutedStyle}>{fill(t('reclaimed'), { count: route.reclaimed.length })}</span>
          : null}
        {route.ownedIds.length > 0
          ? <span style={mutedStyle}>{fill(t('owned'), { count: route.ownedIds.length })}</span>
          : null}
      </div>
      {names.length > 0
        ? (
          <div style={mutedStyle}>
            {shown}
            {rest > 0 ? ` ${fill(t('more'), { count: rest })}` : ''}
          </div>
        )
        : null}
      {reasoning ? <div style={mutedStyle}>{t('reasoningWarning')}</div> : null}
      {route.blocked !== undefined ? <div style={mutedStyle}>{t(BLOCK_KEYS[route.blocked])}</div> : null}
    </div>
  )
}

/**
 * The panel.
 * @param props - injected callbacks and the locale seat.
 * @returns the panel, or nothing while there is nothing to say.
 */
export function CatalogPanel(props: CatalogPanelProps): ReactNode {
  const { call, t } = props
  const [status, setStatus] = useState<CatalogStatusView | undefined>(undefined)
  const [busy, setBusy] = useState<'idle' | 'checking' | 'writing'>('idle')
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [chosen, setChosen] = useState<readonly string[] | undefined>(undefined)

  const run = useCallback(async (endpoint: string, payload?: unknown): Promise<void> => {
    if (call === undefined) return
    setFailure(undefined)
    try {
      setStatus(await call(endpoint, payload))
    } catch (error: unknown) {
      setFailure(error instanceof Error ? error.message : String(error))
    }
  }, [call])

  // One read on mount. It costs no network — the Host answers from what
  // settings already say — and it is also what runs the "dsh caught up" cleanup.
  useEffect(() => { void run('status') }, [run])

  const routes = useMemo(() => (status?.routes ?? []).filter(interesting), [status])
  const selectable = useMemo(() => routes.filter(actionable).map(route => route.route), [routes])
  // Default: everything actionable is selected. An explicit choice replaces it
  // and survives re-reads, minus routes that stopped being actionable.
  const selected = useMemo(
    () => chosen === undefined ? selectable : selectable.filter(route => chosen.includes(route)),
    [chosen, selectable],
  )
  const owned = useMemo(
    () => (status?.routes ?? []).filter(route => route.ownedIds.length > 0).map(route => route.route),
    [status],
  )

  const toggle = useCallback((route: string): void => {
    setChosen(current => (current ?? selectable).includes(route)
      ? (current ?? selectable).filter(entry => entry !== route)
      : [...current ?? selectable, route])
  }, [selectable])

  const act = useCallback(async (endpoint: string, targets: readonly string[]): Promise<void> => {
    setBusy(endpoint === 'preview' ? 'checking' : 'writing')
    try {
      await run(endpoint, endpoint === 'preview' ? {} : { routes: [...targets] })
      setChosen(undefined)
    } finally {
      setBusy('idle')
    }
  }, [run])

  if (status === undefined || call === undefined || t === undefined) return null
  // A composition with no configured pi-ai provider has nothing for this panel
  // to act on, and an empty card at the foot of the page is just noise.
  if (status.routes.length === 0) return null

  const checked = status.fetchedAt !== undefined

  return (
    <section style={panelStyle}>
      <div style={titleStyle}>{t('title')}</div>
      <div style={mutedStyle}>{t('intro')}</div>
      <div style={{ ...rowStyle, ...mutedStyle }}>
        <span>{fill(t('snapshot'), { date: when(status.builtinSnapshotAt) })}</span>
        {checked ? <span>{fill(t('fetched'), { date: when(status.fetchedAt) })}</span> : null}
      </div>
      {(status.reconciled ?? []).map(notice => (
        <div key={notice.route} style={mutedStyle}>
          {fill(t('handedBack'), { count: notice.ids.length, name: notice.displayName })}
        </div>
      ))}
      {routes.map(route => (
        <RouteLine
          key={route.route}
          route={route}
          t={t}
          selected={selected.includes(route.route)}
          onToggle={toggle}
        />
      ))}
      {checked && routes.every(route => !actionable(route)) ? <div style={mutedStyle}>{t('nothing')}</div> : null}
      {status.error !== undefined ? <div style={errorStyle}>{fill(t('failed'), { message: status.error })}</div> : null}
      {failure !== undefined ? <div style={errorStyle}>{fill(t('failed'), { message: failure })}</div> : null}
      <div style={rowStyle}>
        <button
          type="button"
          style={buttonStyle}
          disabled={busy !== 'idle'}
          onClick={() => { void act('preview', []) }}
        >
          {busy === 'checking' ? t('checking') : checked ? t('recheck') : t('check')}
        </button>
        {selected.length > 0
          ? (
            <button
              type="button"
              style={primaryButtonStyle}
              disabled={busy !== 'idle'}
              onClick={() => { void act('apply', selected) }}
            >
              {busy === 'writing' ? t('applying') : t('applySelected')}
            </button>
          )
          : null}
        {owned.length > 0
          ? (
            <button
              type="button"
              style={buttonStyle}
              disabled={busy !== 'idle'}
              onClick={() => { void act('revert', owned) }}
            >
              {t('revert')}
            </button>
          )
          : null}
      </div>
    </section>
  )
}
