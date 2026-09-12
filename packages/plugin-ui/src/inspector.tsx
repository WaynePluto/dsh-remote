import { useEffect } from 'react'
import type { CSSProperties } from 'react'

/** Inspector 视图共用的 dsh 主题 token；业务样式只在此处取值，不重复写 fallback。 */
export const INSPECTOR_BORDER = 'var(--dsw-alias-border-l1, rgba(128,128,128,0.3))'
export const INSPECTOR_PRIMARY = 'var(--dsw-alias-label-primary, inherit)'
export const INSPECTOR_SECONDARY = 'var(--dsw-alias-label-secondary, #6b7280)'
export const INSPECTOR_TERTIARY = 'var(--dsw-alias-label-tertiary, #6b7280)'
export const INSPECTOR_MONO = 'var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)'

/** Inspector tab 的根布局：固定上下结构，让列表区域单独承担滚动。 */
export const inspectorRootStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  height: '100%',
  minHeight: 0,
  fontSize: '13px',
  lineHeight: 1.5,
  color: INSPECTOR_PRIMARY,
}

/** Inspector 顶部工具栏的公共布局。 */
export const inspectorToolbarStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '12px',
  flex: 'none',
  minWidth: 0,
  padding: '10px 16px',
  borderBottom: `0.5px solid ${INSPECTOR_BORDER}`,
}

/** 工具栏左侧摘要的省略规则。 */
export const inspectorSummaryStyle: CSSProperties = {
  flex: '1 1 auto',
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  color: INSPECTOR_SECONDARY,
  whiteSpace: 'nowrap',
}

/** Input 自带外层 span；slot 让它可以随工具栏收缩。 */
export const inspectorSearchSlotStyle: CSSProperties = {
  display: 'grid',
  flex: '0 1 180px',
  minWidth: 0,
}

/** 搜索框本身的公共尺寸约束。 */
export const inspectorSearchInputStyle: CSSProperties = {
  width: '100%',
  minWidth: 0,
  boxSizing: 'border-box',
}

/** 仅列表区域滚动，工具栏和说明不会跟着列表移动。 */
export const inspectorScrollStyle: CSSProperties = {
  flex: '1 1 auto',
  minHeight: 0,
  overflowY: 'auto',
}

/**
 * 分组标题的公共样式。
 * `alignItems` 与 `fontWeight` 是两个现有视图的排版差异，作为参数保留。
 */
export function inspectorGroupHeadingStyle(
  alignItems: CSSProperties['alignItems'] = 'center',
  fontWeight?: CSSProperties['fontWeight'],
): CSSProperties {
  return {
    display: 'flex',
    alignItems,
    gap: '8px',
    padding: '10px 16px 4px',
    color: INSPECTOR_TERTIARY,
    fontSize: '12px',
    ...fontWeight === undefined ? {} : { fontWeight },
  }
}

/** 分组标题末尾的公共细线。 */
export const inspectorRuleStyle: CSSProperties = {
  flex: '1 1 auto',
  height: '0.5px',
  background: INSPECTOR_BORDER,
}

/** 每一行按钮的公共布局、触控区域和继承规则。 */
export const inspectorRowStyle: CSSProperties = {
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

/** 行首状态圆点的公共尺寸。 */
export const inspectorGlyphStyle: CSSProperties = {
  flex: 'none',
  width: '10px',
  color: INSPECTOR_TERTIARY,
  fontSize: '11px',
}

/** 行描述的公共单行省略规则。 */
export const inspectorDescriptionStyle: CSSProperties = {
  flex: '1 1 auto',
  minWidth: 0,
  color: INSPECTOR_SECONDARY,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

/** 来源提示与路径提示共用的等宽灰字。 */
export const inspectorGroupHintStyle: CSSProperties = {
  fontFamily: INSPECTOR_MONO,
  fontSize: '11px',
  opacity: 0.8,
}

/** 底部说明区域的公共布局。 */
export const inspectorNoteStyle: CSSProperties = {
  flex: 'none',
  padding: '10px 16px',
  borderTop: `0.5px solid ${INSPECTOR_BORDER}`,
  color: INSPECTOR_TERTIARY,
  fontSize: '12px',
}

/** 加载中、空列表和错误状态的公共内边距。 */
export const inspectorStateStyle: CSSProperties = {
  padding: '24px 16px',
  color: INSPECTOR_TERTIARY,
}

/**
 * 视图样式表的稳定命名集合，避免两个 Inspector 各自复制同一组对象。
 * 分组标题的两种对齐方式通过 {@link inspectorGroupHeadingStyle} 单独取用。
 */
export const inspectorStyles = {
  root: inspectorRootStyle,
  toolbar: inspectorToolbarStyle,
  summary: inspectorSummaryStyle,
  searchSlot: inspectorSearchSlotStyle,
  searchInput: inspectorSearchInputStyle,
  scroll: inspectorScrollStyle,
  rule: inspectorRuleStyle,
  row: inspectorRowStyle,
  glyph: inspectorGlyphStyle,
  description: inspectorDescriptionStyle,
  groupHint: inspectorGroupHintStyle,
  note: inspectorNoteStyle,
  state: inspectorStateStyle,
} as const

/**
 * 只在页面可见时轮询 Inspector 数据；隐藏标签页停止计时器并保留监听器，
 * 回到前台时立即读一次再恢复固定间隔。
 */
export function useInspectorPolling(load: () => Promise<void>, pollMs: number): void {
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined
    const start = (): void => {
      if (timer !== undefined) return
      void load()
      timer = setInterval(() => { void load() }, pollMs)
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
  }, [load, pollMs])
}
