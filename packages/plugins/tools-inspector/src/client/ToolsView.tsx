/**
 * 「工具」视图：当前会话的 agent 注册了哪些工具、哪些用过、各用了多少次。
 *
 * ## 设计取舍
 *
 * - **一屏一列表，不做仪表盘。** 工具通常 20~40 个，卡片墙要滚三屏才看得完。
 *   顶部一条统计带 + 密度均匀的列表，扫视成本最低。
 * - **分组即排序**：已用（按次数降序）→ 未用（字母序）。用户最想回答的
 *   「agent 到底在用什么」永远落在第一屏顶部，不需要先筛选。
 * - **状态靠字形不靠颜色**：`●` 已用 / `○` 未用。深色主题下颜色容易翻车
 *   （docs/02 §8.6），字形不会。
 * - **描述截断成一行**，点击整行才展开参数。默认收起以保证清爽。
 *
 * ## 为什么只有两档状态
 *
 * dsh 没有 deferred / dynamic tool loading：注册即对模型可见（docs/02 §15.2）。
 * 所以不存在「已注册但未激活」这一档，页脚有一行说明如实告诉用户这件事 ——
 * 这个视图顺带回答了「dsh 有没有工具延迟加载」这个问题，省得用户去读源码。
 * 将来上游若加了 active-set API，{@link GROUPS} 加一行即可。
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { CSSProperties, ReactElement } from 'react'

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

/**
 * ⚠️ 主题变量名严格照 dsh 的拼写。写错不会告警，只会静默用逗号后的兜底值 ——
 * `--dsw-alias-border-l1` 是字母 L 不是数字 1（docs/02 §8.6）。
 *
 * 等宽必须写**完整兜底栈**：`--dsw-font-mono` 是 dsh 引用了四处、定义了零处的名字，
 * 所有人一直在吃兜底，只写 `ui-monospace, monospace` 在 Windows 上会掉到浏览器
 * 默认 fixed 字体（docs/02 §8.6b）。
 */
const BORDER = 'var(--dsw-alias-border-l1, rgba(128,128,128,0.3))'
const PRIMARY = 'var(--dsw-alias-label-primary, inherit)'
const SECONDARY = 'var(--dsw-alias-label-secondary, #6b7280)'
const TERTIARY = 'var(--dsw-alias-label-tertiary, #6b7280)'
const ERROR = 'var(--dsw-alias-state-error-primary, #dc2626)'
const MONO = 'var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)'

const rootStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  height: '100%',
  minHeight: 0,
  fontSize: '13px',
  lineHeight: 1.5,
  color: PRIMARY,
}

const barStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '12px',
  flex: 'none',
  padding: '10px 16px',
  borderBottom: `0.5px solid ${BORDER}`,
}

const summaryStyle: CSSProperties = { color: SECONDARY, whiteSpace: 'nowrap' }

const searchStyle: CSSProperties = {
  marginLeft: 'auto',
  minWidth: 0,
  width: '180px',
  padding: '4px 8px',
  borderRadius: '6px',
  border: `0.5px solid ${BORDER}`,
  background: 'transparent',
  color: 'inherit',
  font: 'inherit',
  outline: 'none',
}

const scrollStyle: CSSProperties = { flex: '1 1 auto', minHeight: 0, overflowY: 'auto' }

const groupHeadStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  padding: '10px 16px 4px',
  color: TERTIARY,
  fontSize: '12px',
}

/** 分组标题右侧那条填满剩余宽度的细线，替代一个空洞的标题行。 */
const ruleStyle: CSSProperties = { flex: '1 1 auto', height: '0.5px', background: BORDER }

const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  gap: '10px',
  width: '100%',
  padding: '5px 16px',
  border: 'none',
  background: 'transparent',
  color: 'inherit',
  font: 'inherit',
  textAlign: 'left',
  cursor: 'pointer',
  boxSizing: 'border-box',
  minWidth: 0,
}

const glyphStyle: CSSProperties = {
  flex: 'none',
  width: '10px',
  color: TERTIARY,
  fontSize: '11px',
}

/**
 * 名称列：**固定宽度**，不是 `minWidth`。
 *
 * ⚠️ 这里曾经用 `minWidth: 148px`，在次数还排在行尾时看不出问题；一旦次数移到名称
 * 之后，`minWidth` 就成了对齐杀手 —— 比 148px 宽的名字（`cordis_inspect_query`、
 * `interactive_terminal_signal`）会把自己的盒子撑开，连带把后面的次数、描述整列右推，
 * 于是短名字那几行的「—」和长名字那几行的对不齐（用户截图里红框圈的就是这个）。
 *
 * 改成 `width` + `flex: none` 让盒子宽度与内容无关，后面每一列的起点就都锁死了。
 * 超长名字仍然**不截断**（工具名被截断就没法搜了，比描述被截断严重得多），
 * 它会溢出到次数列的留白里 —— 这是刻意的取舍：极少数超长名字略微挤占间距，
 * 好过让所有行都失去竖直基准线。
 */
const nameStyle: CSSProperties = {
  flex: 'none',
  fontFamily: MONO,
  width: '196px',
  // 名字比盒子宽时允许它盖到右边的留白上，而不是把布局推开。
  overflow: 'visible',
  whiteSpace: 'nowrap',
}

const descStyle: CSSProperties = {
  flex: '1 1 auto',
  minWidth: 0,
  color: SECONDARY,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

/**
 * 次数：右对齐 + 等宽 + 表格数字，让数字紧贴名字列成一竖列。
 *
 * 放在第二列（名字之后、描述之前）而不是行尾：这一列是用户来这个页面最想看的东西，
 * 排在行尾要横扫过整条描述才够得着，而描述是变长的，眼睛落点每行都不一样。
 * 右对齐 + `tabular-nums` 是关键 —— 个位/十位/百位必须在同一竖线上收齐，
 * 否则「放到第二列」反而比行尾更乱。
 *
 * ⚠️ 同样用 `width` 而不是 `minWidth`：三位数（`252 次`）会把 `minWidth` 盒子撑开，
 * 把描述整列右推，于是描述的起点每行都不一样。
 *
 * 与描述之间的距离由后面那格常驻的失败列 + 行 `gap` 一起拉开，这里不再额外加
 * `paddingRight`，免得两处留白叠加。
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

const paramStyle: CSSProperties = { fontFamily: MONO, color: PRIMARY }

const noteStyle: CSSProperties = {
  flex: 'none',
  padding: '10px 16px',
  borderTop: `0.5px solid ${BORDER}`,
  color: TERTIARY,
  fontSize: '12px',
}

const stateStyle: CSSProperties = { padding: '24px 16px', color: TERTIARY }

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
 * @returns 一行（可能带展开的参数行）。
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

  // 只在页面可见时轮询：切走的标签页不该继续打宿主。
  useEffect(() => {
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
      if (document.visibilityState === 'visible') start()
      else stop()
    }
    if (document.visibilityState === 'visible') start()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [load])

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
        <input
          style={searchStyle}
          type="search"
          value={query}
          placeholder={t('search')}
          aria-label={t('search')}
          onChange={event => { setQuery(event.target.value) }}
        />
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
