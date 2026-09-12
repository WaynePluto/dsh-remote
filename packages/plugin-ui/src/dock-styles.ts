/**
 * services 与 terminal 共用的 dock card 内联样式和主题 token。
 *
 * 这些值直接复用 dsh todo dock 的宽度轴、表面和表头结构；具体 panel 只保留自己的 body 样式。
 */

import type { CSSProperties } from 'react'

/** composer 与 dock 共享的左右留白 token。 */
export const CLEARANCE = 'var(--dsh-composer-side-clearance, 16px)'
/** dock card 内外共享的缩进 token。 */
export const INSET = 'var(--dsh-composer-dock-inset, 8px)'
/** composer card 的最大宽度 token。 */
export const CARD_MAX = 'var(--dsh-composer-card-max-width, 952px)'

/** 主题 token 必须完全按 dsh 定义拼写；`border-l1` 中的 l 是字母 L。 */
export const BORDER = 'var(--dsw-alias-border-l1, rgba(128,128,128,0.3))'
export const SECONDARY = 'var(--dsw-alias-label-secondary, #6b7280)'
export const TERTIARY = 'var(--dsw-alias-label-tertiary, #6b7280)'
export const MONO = 'var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)'

/** card surface 复用 dsh todo panel 的 elevated surface，确保浅色和深色主题都可见。 */
export const SURFACE = 'var(--dsw-specific-tip, rgba(128,128,128,0.1))'

/** 图标与文字 flex 居中后的光学补偿，按已测量的 1.5px 误差换算为 em。 */
const GLYPH_OPTICAL_SHIFT = 'translateY(0.115em)'

/** dock card 根节点的宽度轴、表面与溢出规则。 */
export const rootStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  flex: 'none',
  margin: '0 auto',
  width: `calc(100% - ${CLEARANCE} * 2 - ${INSET} * 4)`,
  maxWidth: `calc(${CARD_MAX} - ${INSET} * 4)`,
  minWidth: 0,
  boxSizing: 'border-box',
  // 0.5px 和 12px 是 dsh 对该 card 的原始尺寸。
  borderRadius: '12px',
  border: `0.5px solid ${BORDER}`,
  background: SURFACE,
  fontSize: '13px',
  lineHeight: 1.5,
  overflow: 'hidden',
}

/** 表头用 stretch 让各个 cell 等高，再由每个 cell 自己居中内容。 */
export const headerStyle: CSSProperties = {
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

/** 表头 leading glyph cell。 */
export const leadStyle: CSSProperties = {
  display: 'flex',
  flex: 'none',
  alignItems: 'center',
  justifyContent: 'center',
  lineHeight: 0,
  transform: GLYPH_OPTICAL_SHIFT,
  color: TERTIARY,
}

/** disclosure chevron cell，与 lead 使用相同的光学位移。 */
export const chevronStyle: CSSProperties = {
  display: 'flex',
  flex: 'none',
  alignItems: 'center',
  justifyContent: 'center',
  lineHeight: 0,
  transform: GLYPH_OPTICAL_SHIFT,
  color: TERTIARY,
}

/** 表头标题文字的 flex cell。 */
export const titleStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  flex: '0 0 auto',
  fontSize: '13px',
  fontWeight: 500,
  color: 'var(--dsw-alias-label-primary, inherit)',
  whiteSpace: 'nowrap',
}

/** 表头摘要的 flex cell。 */
export const summaryStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  color: TERTIARY,
  fontSize: '13px',
  flex: '1 1 auto',
  minWidth: 0,
}

/** summary 的文字 box；省略号放在内层文字，而不是 flex cell。 */
export const summaryTextStyle: CSSProperties = {
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}
