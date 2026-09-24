/** models-catalog panel：读取 status/preview，展示 provider route facts，并提交用户选择的 apply/revert。 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { Button, IconChevronDownOutlineMedium } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CatalogStatusView, RoutePreview } from '../shared.js'
import { fill } from './locales.js'
import type { CatalogKey } from './locales.js'

/** 每个 route 预览显示的 model 名称数量。 */
const NAME_PREVIEW = 6

/** panel 使用的 Host RPC 注入。 */
export interface CatalogPanelInjected {
  /** 调用 status/preview/apply/revert endpoint。 */
  call: (endpoint: string, payload?: unknown) => Promise<CatalogStatusView>
}

/** panel 的组合 props。 */
export type CatalogPanelProps = Partial<CatalogPanelInjected> & {
  /** 本插件 locale 函数。 */
  t?: (key: CatalogKey) => string
}

// 复用 ModelsSection 的 panel spacing/theme tokens；border 使用 border-l4，表面保持 dsh 层级。
const panelStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '12px',
  boxSizing: 'border-box',
  padding: '12px 14px',
  border: '0.5px solid var(--dsw-alias-border-l4, rgba(128,128,128,0.2))',
  borderRadius: '16px',
  fontSize: '13px',
}

const headerStyle: CSSProperties = {
  width: '100%',
  appearance: 'none',
  padding: 0,
  border: 0,
  background: 'transparent',
  color: 'inherit',
  font: 'inherit',
  textAlign: 'left',
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'stretch',
  gap: '8px',
}

const titleStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  display: 'flex',
  alignItems: 'center',
  fontSize: '14px',
  lineHeight: '22px',
  fontWeight: 500,
  color: 'var(--dsw-alias-label-primary, inherit)',
}

const chevronStyle: CSSProperties = {
  flex: 'none',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  lineHeight: 0,
  color: 'var(--dsw-alias-label-tertiary, #6b7280)',
  transition: 'transform 120ms ease',
}

const contentStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: '10px' }

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

const errorStyle: CSSProperties = { color: 'var(--dsw-alias-state-error-primary, #dc2626)' }

/** RouteBlock 到本地化文案 key 的映射。 */
const BLOCK_KEYS = {
  'no-template': 'blockedNoTemplate',
  'no-source': 'blockedNoSource',
  'foreign-models': 'blockedForeign',
} as const satisfies Record<NonNullable<RoutePreview['blocked']>, CatalogKey>

/** 将 snapshot epoch 时间格式化为页面日期。 */
function when(value: number | undefined): string {
  return value === undefined ? '—' : new Date(value).toLocaleDateString()
}

/** route 有 additions/reclaimed 时可勾选并执行操作。 */
function actionable(route: RoutePreview): boolean {
  return route.additions.length > 0 || route.reclaimed.length > 0 || (route.upgradableIds?.length ?? 0) > 0
}

/** 只展示有变化、owned ids 或 no-template 的 route。 */
function interesting(route: RoutePreview): boolean {
  return actionable(route) || route.ownedIds.length > 0 || route.blocked === 'no-template'
}

/** 一行 route preview，展示 additions/reclaimed/owned 和 blocked 原因。 */
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
        {(route.upgradableIds?.length ?? 0) > 0
          ? <span style={mutedStyle}>{fill(t('upgradable'), { count: route.upgradableIds?.length ?? 0 })}</span>
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

/** 读取状态、管理 chosen routes，并渲染可折叠 catalog panel。 */
export function CatalogPanel(props: CatalogPanelProps): ReactNode {
  const { call, t } = props
  const [status, setStatus] = useState<CatalogStatusView | undefined>(undefined)
  // open/selection 是页面本地状态；status 初始读取不写 settings。
  const [open, setOpen] = useState(false)
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

  // panel mount 后读取最新 status，失败只显示 local failure。
  useEffect(() => { void run('status') }, [run])

  const routes = useMemo(() => (status?.routes ?? []).filter(interesting), [status])
  const selectable = useMemo(() => routes.filter(actionable).map(route => route.route), [routes])
  // chosen 未定义时默认选择所有可操作 route；用户改动后只保留选择草稿。
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
  // 没有可展示 route 时不占用页面空间。
  if (status.routes.length === 0) return null

  const checked = status.fetchedAt !== undefined

  return (
    <section style={panelStyle}>
      <button
        type="button"
        style={headerStyle}
        aria-expanded={open}
        onClick={() => { setOpen(value => !value) }}
      >
        <span style={titleStyle}>{t('title')}</span>
        <span style={{ ...chevronStyle, transform: open ? 'rotate(180deg)' : undefined }} aria-hidden="true">
          <IconChevronDownOutlineMedium />
        </span>
      </button>
      {open
        ? (
          <div style={contentStyle}>
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
              <Button
                variant="outline"
                size="sm"
                disabled={busy !== 'idle'}
                onClick={() => { void act('preview', []) }}
              >
                {busy === 'checking' ? t('checking') : checked ? t('recheck') : t('check')}
              </Button>
              {selected.length > 0
                ? (
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={busy !== 'idle'}
                    onClick={() => { void act('apply', selected) }}
                  >
                    {busy === 'writing' ? t('applying') : selected.some(route =>
                      (status.routes.find(item => item.route === route)?.additions.length ?? 0) > 0)
                      ? t('applySelected') : t('updateSelected')}
                  </Button>
                )
                : null}
              {owned.length > 0
                ? (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy !== 'idle'}
                    onClick={() => { void act('revert', owned) }}
                  >
                    {t('revert')}
                  </Button>
                )
                : null}
            </div>
          </div>
        )
        : null}
    </section>
  )
}
