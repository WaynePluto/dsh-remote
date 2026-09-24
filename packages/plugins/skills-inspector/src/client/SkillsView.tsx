/**
 * 「技能」视图：展示本会话的技能目录、来源和加载历史。
 *
 * 「已加载」单独置顶并按最近加载排序，未加载项按来源分组；`●/○` 表示加载状态。
 * `session.openWorkspacePath` 打开宿主机桌面，远程用户不可见，因此先调用
 * `session.canOpenWorkspacePath()`，只在可用时显示「在本机打开」。
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { CSSProperties, ReactElement } from 'react'
import {
  INSPECTOR_MONO, INSPECTOR_PRIMARY, INSPECTOR_SECONDARY, INSPECTOR_TERTIARY,
  inspectorGroupHeadingStyle, inspectorStyles, useInspectorPolling,
} from '@dsh-station/plugin-ui'
import { Button, Input, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  filterEntries, groupBySource, sortLoaded,
  type SkillEntry, type SkillLocation, type SkillSource, type SkillsSnapshot,
} from '../shared.js'
import type { SkillsKey } from './locales.js'

/** 轮询间隔。宿主侧只是读一次技能目录（有缓存）加一次日志回放，5 秒足够跟上。 */
export const POLL_MS = 5000

/** 有本地化标题的来源桶；其余落到 `source.unknown`。 */
const KNOWN_SOURCES = new Set<string>([
  'project-dsh', 'project-agents', 'custom',
  'user-dsh', 'user-agents', 'runtime', 'bundled',
])

/**
 * 一个来源的标题 / 路径提示 key。
 * @param source - 来源桶。
 * @returns 两个文案 key。
 */
export function sourceKeys(source: SkillSource): { title: SkillsKey; hint: SkillsKey } {
  const known = KNOWN_SOURCES.has(source)
  return known
    ? { title: `source.${source}` as SkillsKey, hint: `source.${source}.hint` as SkillsKey }
    : { title: 'source.unknown', hint: 'source.unknown.hint' }
}

const {
  root: rootStyle,
  toolbar: barStyle,
  summary: summaryStyle,
  searchSlot: searchSlotStyle,
  searchInput: searchInputStyle,
  scroll: scrollStyle,
  rule: ruleStyle,
  row: rowStyle,
  glyph: glyphStyle,
  description: descStyle,
  groupHint: groupHintStyle,
  note: noteStyle,
  state: stateStyle,
} = inspectorStyles
const groupHeadStyle = inspectorGroupHeadingStyle('baseline', 'normal')
const PRIMARY = INSPECTOR_PRIMARY
const SECONDARY = INSPECTOR_SECONDARY
const TERTIARY = INSPECTOR_TERTIARY
const MONO = INSPECTOR_MONO
const WARN = 'var(--dsw-alias-state-warn-label, #b45309)'
const ERROR = 'var(--dsw-alias-state-error-primary, #dc2626)'
const nameStyle: CSSProperties = {
  flex: 'none',
  fontFamily: MONO,
  // 等宽 + 固定宽度让名字成一列；超长名字自然溢出到描述前面，不截断
  // （技能名被截断就没法搜了，比描述被截断严重得多）。
  minWidth: '168px',
}

/** 已加载行右侧的「模型 / 用户 ×2」微标，右对齐成一列。 */
const byStyle: CSSProperties = {
  flex: 'none',
  color: TERTIARY,
  fontSize: '12px',
  textAlign: 'right',
  minWidth: '56px',
  whiteSpace: 'nowrap',
}

/** 界面契约：此处说明布局、主题 token、尺寸或 DOM 接缝。*/
const badgeSlotStyle: CSSProperties = {
  display: 'inline-flex',
  flex: 'none',
}

const detailStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '4px',
  padding: '2px 16px 10px 36px',
  color: SECONDARY,
  fontSize: '12px',
}

const detailRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  gap: '8px',
  flexWrap: 'wrap',
  minWidth: 0,
}

const detailLabelStyle: CSSProperties = { flex: 'none', color: TERTIARY }

const detailTextStyle: CSSProperties = {
  flex: '1 1 auto',
  minWidth: 0,
  color: PRIMARY,
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
}

/** 路径本身：等宽、可选中复制 —— 远程用户唯一能用的那条信息。 */
const pathStyle: CSSProperties = {
  fontFamily: MONO,
  fontSize: '11px',
  color: SECONDARY,
  wordBreak: 'break-all',
  userSelect: 'text',
  minWidth: 0,
}

/** 实现说明：此处记录相关接口、边界和生命周期约束。*/
const openButtonStyle: CSSProperties = { flex: 'none' }

const errorTextStyle: CSSProperties = { color: ERROR }

const warnStyle: CSSProperties = { color: WARN }

/** 本视图从自己的注册里拿到的东西。 */
export interface SkillsViewInjected {
  /** 向宿主要一份快照。 */
  readonly onSnapshot: () => Promise<SkillsSnapshot>
  /** 要一个技能的精确本地文件路径（点开某一行时才调）。 */
  readonly onLocate: (name: string) => Promise<SkillLocation>
  /** 这个部署能否把路径交给宿主机桌面打开。 */
  readonly onCanOpen: () => Promise<boolean>
  /** 请求宿主机打开一个路径。 */
  readonly onOpen: (path: string) => Promise<void>
}

/** 视图 props：注入面 + 绑定好的翻译函数。 */
export interface SkillsViewProps extends SkillsViewInjected {
  /** 绑定到本命名空间的翻译函数。 */
  readonly t: (key: SkillsKey, params?: Record<string, string | number>) => string
}

/** 展开某一行后，这一行的定位状态。 */
interface LocationState {
  readonly status: 'locating' | 'ready' | 'failed'
  readonly location?: SkillLocation
  readonly message?: string
}

/**
 * 渲染一行技能的展开区：完整描述、何时使用、来源、本地文件路径。
 * @param props - 条目、定位状态、打开能力与回调。
 * @returns 展开区元素。
 */
function SkillDetail({ entry, location, canOpen, onOpen, t }: {
  entry: SkillEntry
  location: LocationState | undefined
  canOpen: boolean
  onOpen: (path: string) => void
  t: SkillsViewProps['t']
}): ReactElement {
  const keys = sourceKeys(entry.source)
  return (
    <div style={detailStyle}>
      <div style={detailRowStyle}>
        <span style={detailLabelStyle}>{t('descriptionLabel')}:</span>
        <span style={detailTextStyle}>{entry.fullDescription || t('noDescription')}</span>
      </div>
      {entry.whenToUse === undefined
        ? null
        : (
            <div style={detailRowStyle}>
              <span style={detailLabelStyle}>{`${t('whenToUse')}:`}</span>
              <span>{entry.whenToUse}</span>
            </div>
          )}

      <div style={detailRowStyle}>
        <span style={detailLabelStyle}>{`${t('sourceLabel')}:`}</span>
        <span>{t(keys.title)}</span>
        <span style={groupHintStyle}>{t(keys.hint, { provider: entry.provider })}</span>
      </div>

      <div style={detailRowStyle}>
        {location === undefined || location.status === 'locating'
          ? <span>{t('locating')}</span>
          : location.status === 'failed'
            ? <span style={errorTextStyle}>{location.message}</span>
            : location.location?.path === undefined
              ? <span>{t('noPath', { provider: entry.provider })}</span>
              : (
                  <>
                    <span style={pathStyle}>{location.location.path}</span>
                    {canOpen
                      ? (
                          <Button
                            variant="outline"
                            size="sm"
                            style={openButtonStyle}
                            onClick={(event) => {
                              event.stopPropagation()
                              onOpen(location.location?.path ?? '')
                            }}
                          >
                            {t('openLocal')}
                          </Button>
                        )
                      : null}
                  </>
                )}
      </div>
    </div>
  )
}

/**
 * 渲染一行技能。
 * @param props - 条目、展开态、切换回调与翻译函数。
 * @returns 一行（可能带展开区）。
 */
function SkillRow({ entry, expanded, onToggle, location, canOpen, onOpen, t }: {
  entry: SkillEntry
  expanded: boolean
  onToggle: () => void
  location: LocationState | undefined
  canOpen: boolean
  onOpen: (path: string) => void
  t: SkillsViewProps['t']
}): ReactElement {
  const loaded = entry.loaded
  // 「仅用户可调用」是真实存在的一档（`disable-model-invocation` 技能），
  // 它解释了「为什么模型从来不用这个」，值得在行上直说。
  const badge = !entry.modelInvocable
    ? t('userOnly')
    : !entry.userInvocable ? t('modelOnly') : undefined

  return (
    <div>
      <button type="button" style={rowStyle} onClick={onToggle} aria-expanded={expanded}>
        <span style={glyphStyle} aria-hidden="true">{loaded === undefined ? '○' : '●'}</span>
        <span style={nameStyle}>{entry.name}</span>
        <span style={descStyle}>{entry.description}</span>
        {badge === undefined ? null : <span style={badgeSlotStyle}><Tag tone="outline">{badge}</Tag></span>}
        {loaded === undefined
          ? null
          : (
              <span style={byStyle}>
                {t(loaded.by === 'model' ? 'byModel' : 'byUser')}
                {loaded.count > 1 ? ` ${t('loadedTimes', { count: loaded.count })}` : ''}
              </span>
            )}
      </button>
      {expanded
        ? (
            <SkillDetail
              entry={entry}
              location={location}
              canOpen={canOpen}
              onOpen={onOpen}
              t={t}
            />
          )
        : null}
    </div>
  )
}

/**
 * 「技能」视图本体。
 * @param props - 注入面与翻译函数。
 * @returns 视图元素。
 */
export function SkillsView({
  onSnapshot, onLocate, onCanOpen, onOpen, t,
}: SkillsViewProps): ReactElement {
  const [snapshot, setSnapshot] = useState<SkillsSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [locations, setLocations] = useState<Record<string, LocationState>>({})
  const [canOpen, setCanOpen] = useState(false)
  const [openError, setOpenError] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    try {
      setSnapshot(await onSnapshot())
      setError(null)
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [onSnapshot])

  useInspectorPolling(load, POLL_MS)
  // 「本机能否打开」问一次就够：它是部署形态决定的，不随会话变化。
  useEffect(() => {
    let alive = true
    void onCanOpen()
      .then((value) => {
        if (alive) setCanOpen(value)
        return value
      })
      .catch(() => { if (alive) setCanOpen(false) })
    return () => { alive = false }
  }, [onCanOpen])

  /** 展开一行：这时才向宿主要精确路径（它会连带读技能正文，不能批量做）。 */
  const toggle = useCallback((name: string): void => {
    setOpenError(null)
    setExpanded((current) => {
      if (current === name) return null
      setLocations((existing) => {
        if (existing[name] !== undefined) return existing
        void onLocate(name)
          .then((location) => {
            setLocations(next => ({ ...next, [name]: { status: 'ready', location } }))
            return location
          })
          .catch((cause: unknown) => {
            setLocations(next => ({
              ...next,
              [name]: {
                status: 'failed',
                message: cause instanceof Error ? cause.message : String(cause),
              },
            }))
          })
        return { ...existing, [name]: { status: 'locating' } }
      })
      return name
    })
  }, [onLocate])

  const open = useCallback((path: string): void => {
    setOpenError(null)
    void onOpen(path).catch((cause: unknown) => {
      setOpenError(cause instanceof Error ? cause.message : String(cause))
    })
  }, [onOpen])

  const visible = useMemo(
    () => filterEntries(snapshot?.entries ?? [], query),
    [snapshot, query],
  )
  const loadedRows = useMemo(
    () => sortLoaded(visible.filter(entry => entry.loaded !== undefined)),
    [visible],
  )
  const groups = useMemo(
    () => groupBySource(visible.filter(entry => entry.loaded === undefined)),
    [visible],
  )

  if (error !== null) {
    return <div style={rootStyle}><div style={stateStyle}>{t('failed', { message: error })}</div></div>
  }
  if (snapshot === null) {
    return <div style={rootStyle}><div style={stateStyle}>{t('loading')}</div></div>
  }

  /**
   * 渲染一组行，避免「已加载」与来源分组各写一遍。
   * @param entries - 组内条目。
   * @returns 行元素数组。
   */
  const rows = (entries: readonly SkillEntry[]): ReactElement[] => entries.map(entry => (
    <SkillRow
      key={entry.name}
      entry={entry}
      expanded={expanded === entry.name}
      onToggle={() => { toggle(entry.name) }}
      location={locations[entry.name]}
      canOpen={canOpen}
      onOpen={open}
      t={t}
    />
  ))

  return (
    <div style={rootStyle}>
      <div style={barStyle}>
        <span style={summaryStyle}>
          {t('summary', { total: snapshot.total, loaded: snapshot.loaded })}
        </span>
        <span style={searchSlotStyle}>
          <Input
            style={searchInputStyle}
            type="search"
            value={query}
            placeholder={t('search')}
            aria-label={t('search')}
            onChange={event => { setQuery(event.target.value) }}
          />
        </span>
      </div>

      <div style={scrollStyle}>
        {snapshot.entries.length === 0
          ? <div style={stateStyle}>{t('empty')}</div>
          : visible.length === 0
            ? <div style={stateStyle}>{t('noMatch')}</div>
            : (
                <>
                  {loadedRows.length === 0
                    ? null
                    : (
                        <section>
                          <h3 style={groupHeadStyle}>
                            <span>{t('groupLoaded')}</span>
                            <span style={ruleStyle} aria-hidden="true" />
                          </h3>
                          {rows(loadedRows)}
                        </section>
                      )}
                  {groups.map((group) => {
                    const keys = sourceKeys(group.source)
                    return (
                      <section key={group.source}>
                        <h3 style={groupHeadStyle}>
                          <span>{t(keys.title)}</span>
                          <span style={groupHintStyle}>
                            {t(keys.hint, { provider: group.entries[0]?.provider ?? '' })}
                          </span>
                          <span style={ruleStyle} aria-hidden="true" />
                        </h3>
                        {rows(group.entries)}
                      </section>
                    )
                  })}
                </>
              )}
      </div>

      {/*
        页脚不是装饰：第一行界定「已加载」的口径（否则用户会以为是「当前上下文里仍在场」），
        第二行说明这是只读观察窗口 —— 免得用户找「加载」按钮找半天。
        列表不完整时额外顶一行警告，而不是让技能看起来凭空消失。
      */}
      <div style={noteStyle}>
        {snapshot.complete ? null : <div style={warnStyle}>{t('incomplete')}</div>}
        {openError === null
          ? null
          : <div style={errorTextStyle}>{t('openFailed', { message: openError })}</div>}
        <div>{t('scopeNote')}</div>
        <div>{t('readOnlyNote')}</div>
      </div>
    </div>
  )
}
