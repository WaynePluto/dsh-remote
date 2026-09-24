/**
 * 「工具」视图：展示当前 agent 的工具、调用状态和历史次数。
 * 已用按次数降序、未用按名字排序；描述默认单行截断，点击整行展开。
 * dsh 注册工具后即对模型可见，没有 deferred/dynamic loading，因此只显示「已用/未用」；
 * {@link GROUPS} 是未来 active-set API 增加第三档的唯一分组入口。
 */

import { useCallback, useMemo, useState } from 'react'
import type { CSSProperties, ReactElement } from 'react'
import {
  INSPECTOR_MONO, INSPECTOR_PRIMARY, INSPECTOR_SECONDARY, INSPECTOR_TERTIARY,
  inspectorGroupHeadingStyle, inspectorStyles, useInspectorPolling,
} from '@dsh-station/plugin-ui'
import { Input } from '@deepseek-ai/dsh-client-ui-primitives'
import { filterEntries, type ToolEntry, type ToolStatus, type ToolsSnapshot } from '../shared.js'
import type { ToolsKey } from './locales.js'

/** 轮询间隔。宿主侧只是读两张内存表，5 秒足够跟上，也不至于打扰。 */
export const POLL_MS = 5000

/**
 * 分组顺序与其标题 key。
 *
 * ⚠️ 这里就是「将来 dsh 加了 active-set API 就多一档」的那个位置：
 * 加一个 `['inactive', 'groupInactive']` 条目，并在 shared.ts 的 {@link ToolStatus}
 * 加上对应成员即可，其余渲染逻辑不用动。
 */
export const GROUPS: readonly (readonly [ToolStatus, ToolsKey])[] = [
  ['used', 'groupUsed'],
  ['unused', 'groupUnused'],
]

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
  note: noteStyle,
  state: stateStyle,
} = inspectorStyles
const groupHeadStyle = inspectorGroupHeadingStyle()
const PRIMARY = INSPECTOR_PRIMARY
const SECONDARY = INSPECTOR_SECONDARY
const TERTIARY = INSPECTOR_TERTIARY
const MONO = INSPECTOR_MONO
const ERROR = 'var(--dsw-alias-state-error-primary, #dc2626)'
/**
 * 名称列固定 `width` + `flex: none`，避免长工具名把次数和描述列右推。
 * 名称不截断，允许溢出到次数列留白；这比截断工具名更利于搜索。
 */
const nameStyle: CSSProperties = {
  flex: 'none',
  fontFamily: MONO,
  width: '196px',
  // 名字比盒子宽时允许它盖到右边的留白上，而不是把布局推开。
  overflow: 'visible',
  whiteSpace: 'nowrap',
}

/**
 * 次数列放在名称之后，右对齐并使用 `tabular-nums`，让每行数字落在同一竖线上。
 * `width` 固定列起点；失败列常驻占位，避免有/无失败时描述列左右跳动。
 */
const countStyle: CSSProperties = {
  flex: 'none',
  fontFamily: MONO,
  fontVariantNumeric: 'tabular-nums',
  textAlign: 'right',
  width: '58px',
  color: SECONDARY,
}

/**
 * 失败数：贴着次数，是次数的修饰而不是独立一列。
 *
 * ⚠️ **固定宽度且常驻**：这一格是条件内容，若只在有失败时才渲染，有失败的那几行
 * 描述就会比其他行右移；宽度若随位数变化，同样会让描述列参差。宽度按最常见的
 * 「NN 次失败 / NN failed」预留，右侧留白与描述分开。
 */
const failStyle: CSSProperties = {
  flex: 'none',
  color: ERROR,
  fontSize: '12px',
  width: '68px',
  paddingRight: '4px',
  overflow: 'hidden',
  whiteSpace: 'nowrap',
}

const detailStyle: CSSProperties = {
  padding: '2px 16px 10px 36px',
  color: SECONDARY,
  fontSize: '12px',
}
const detailRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: '8px',
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

const paramStyle: CSSProperties = { fontFamily: MONO, color: PRIMARY }

/** 本视图从自己的注册里拿到的东西。 */
export interface ToolsViewInjected {
  /** 向宿主要一份快照。 */
  readonly onSnapshot: () => Promise<ToolsSnapshot>
}

/** 视图 props：注入面 + 绑定好的翻译函数。 */
export interface ToolsViewProps extends ToolsViewInjected {
  /** 绑定到本命名空间的翻译函数。 */
  readonly t: (key: ToolsKey, params?: Record<string, string | number>) => string
}

/**
 * 渲染一行工具。
 * @param props - 条目、展开态、切换回调与翻译函数。
 * @returns 一行（可能带展开的描述与参数）。
 */
function ToolRow({ entry, expanded, onToggle, t }: {
  entry: ToolEntry
  expanded: boolean
  onToggle: () => void
  t: ToolsViewProps['t']
}): ReactElement {
  return (
    <div>
      <button type="button" style={rowStyle} onClick={onToggle} aria-expanded={expanded}>
        <span style={glyphStyle} aria-hidden="true">{entry.status === 'used' ? '●' : '○'}</span>
        <span style={nameStyle}>{entry.name}</span>
        {/*
          次数紧跟名字：它是本页最想被看到的一列。失败数贴着次数，因为它是次数的
          修饰而不是独立一列。描述放最后吸收剩余宽度 —— 它是变长的，只有放在末尾
          才不会把前面几列的位置推得每行都不一样。

          ⚠️ 失败数那格**无论有没有失败都要占位**：它是条件渲染的，只在有失败的行
          出现的话，那几行的描述就会比别的行右移一截（截图里 edit / glob 两行就是
          这样）。所以没有失败时渲染一个空占位，保证描述列在每一行都从同一处开始。
        */}
        <span style={countStyle}>
          {entry.calls > 0 ? t('callsUnit', { count: entry.calls }) : t('never')}
        </span>
        <span style={failStyle} aria-hidden={entry.failures === 0}>
          {entry.failures > 0 ? t('failures', { count: entry.failures }) : ''}
        </span>
        <span style={descStyle}>{entry.description}</span>
      </button>
      {expanded
        ? (
            <div style={detailStyle}>
              <div style={detailRowStyle}>
                <span style={detailLabelStyle}>{t('descriptionLabel')}:</span>
                <span style={detailTextStyle}>{entry.fullDescription || t('noDescription')}</span>
              </div>
              {entry.params.length === 0
                ? t('noParams')
                : (
                    <>
                      {`${t('paramsLabel')}: `}
                      {entry.params.map((param, index) => (
                        <span key={param}>
                          {index > 0 ? ', ' : ''}
                          <span style={paramStyle}>{param}</span>
                          {entry.required.includes(param) ? ` (${t('required')})` : ''}
                        </span>
                      ))}
                    </>
                  )}
            </div>
          )
        : null}
    </div>
  )
}

/**
 * 「工具」视图本体。
 * @param props - 注入面与翻译函数。
 * @returns 视图元素。
 */
export function ToolsView({ onSnapshot, t }: ToolsViewProps): ReactElement {
  const [snapshot, setSnapshot] = useState<ToolsSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    try {
      setSnapshot(await onSnapshot())
      setError(null)
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [onSnapshot])

  useInspectorPolling(load, POLL_MS)
  const visible = useMemo(
    () => filterEntries(snapshot?.entries ?? [], query),
    [snapshot, query],
  )

  if (error !== null) {
    return <div style={rootStyle}><div style={stateStyle}>{t('failed', { message: error })}</div></div>
  }
  if (snapshot === null) {
    return <div style={rootStyle}><div style={stateStyle}>{t('loading')}</div></div>
  }

  return (
    <div style={rootStyle}>
      <div style={barStyle}>
        <span style={summaryStyle}>
          {t('summary', {
            registered: snapshot.registered,
            used: snapshot.used,
            calls: snapshot.totalCalls,
          })}
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
            : GROUPS.map(([status, titleKey]) => {
              const rows = visible.filter(entry => entry.status === status)
              if (rows.length === 0) return null
              return (
                <section key={status}>
                  <h3 style={groupHeadStyle}>
                    <span>{t(titleKey)}</span>
                    <span style={ruleStyle} aria-hidden="true" />
                  </h3>
                  {rows.map(entry => (
                    <ToolRow
                      key={entry.name}
                      entry={entry}
                      expanded={expanded === entry.name}
                      onToggle={() => { setExpanded(current => current === entry.name ? null : entry.name) }}
                      t={t}
                    />
                  ))}
                </section>
              )
            })}
      </div>

      {/*
        两行说明都不是装饰：第一行界定统计范围（否则用户会以为是全历史），
        第二行回答「dsh 有没有工具延迟加载」——这正是这个视图存在时用户最容易问的问题。
      */}
      <div style={noteStyle}>
        <div>{t('scopeNote')}</div>
        <div>{t('deferNote')}</div>
      </div>
    </div>
  )
}
