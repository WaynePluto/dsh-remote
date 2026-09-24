/**
 * terminal dock 使用的全部内联样式与主题 token。
 *
 * 这里不引入 CSS 文件，保持 dsh 页面冻结 module table 下的轻量 panel 形状。
 */

import type { CSSProperties } from 'react'

import {
  BORDER as DOCK_BORDER,
  MONO as DOCK_MONO,
  SECONDARY as DOCK_SECONDARY,
} from '@dsh-station/plugin-ui'

export {
  MONO,
  chevronStyle,
  headerStyle,
  leadStyle,
  rootStyle,
  summaryStyle,
  summaryTextStyle,
  titleStyle,
} from '@dsh-station/plugin-ui'

export const bodyStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '6px',
  padding: '0 12px 10px',
  minWidth: 0,
}

/** 多 terminal 时的 tab 容器。 */
export const tabsStyle: CSSProperties = {
  display: 'flex',
  gap: '6px',
  flexWrap: 'wrap',
  minWidth: 0,
}

/** 终端画面滚动区域。 */
export const screenStyle: CSSProperties = {
  maxHeight: '18em',
  overflowY: 'auto',
  overflowX: 'auto',
  // 防止嵌套滚动器到达底部后继续滚动 transcript，尤其保护移动端触控。
  overscrollBehavior: 'contain',
  margin: 0,
  padding: '6px 8px',
  borderRadius: '8px',
  border: `1px solid ${DOCK_BORDER}`,
  background: 'rgba(128,128,128,0.1)',
  fontFamily: DOCK_MONO,
  fontSize: '11px',
  lineHeight: 1.45,
  whiteSpace: 'pre',
  minWidth: 0,
  maxWidth: '100%',
  boxSizing: 'border-box',
}

/** 输入框与操作按钮的横向布局。 */
export const inputRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '6px',
  minWidth: 0,
}

/** 终端输入框样式。 */
export const inputClass = 'dshx-terminal-input'
export const inputStyles = `
.${inputClass} {
  box-sizing: border-box;
  flex: 1 1 auto;
  min-width: 0;
  height: 32px;
  padding: 0 8px;
  border: 0.5px solid var(--dsw-alias-border-l4);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-family: ${DOCK_MONO};
  font-size: 12px;
  line-height: 1.5;
}
.${inputClass}:focus {
  outline: none;
  border-color: var(--dsw-alias-brand-primary);
}
.${inputClass}:disabled {
  color: var(--dsw-alias-label-tertiary);
  opacity: 0.6;
  cursor: default;
}
`.trim()

/** 正常提示文案样式。 */
export const noteStyle: CSSProperties = {
  color: DOCK_SECONDARY,
  fontSize: '12px',
  minWidth: 0,
  overflowWrap: 'anywhere',
}

/** 错误提示文案样式。 */
export const errorStyle: CSSProperties = {
  ...noteStyle,
  color: 'var(--dsw-alias-state-error-primary, #dc2626)',
}
