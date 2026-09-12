import type { CSSProperties } from 'react'

const border = 'var(--dsw-alias-border-l1, rgba(128,128,128,0.28))'
const muted = 'var(--dsw-alias-label-secondary, #6b7280)'
const error = 'var(--dsw-alias-state-error-primary, #dc2626)'

export const page: CSSProperties = {
  boxSizing: 'border-box',
  display: 'flex',
  flexDirection: 'column',
  gap: '14px',
  minWidth: 0,
  padding: '12px 14px',
  border: '0.5px solid var(--dsw-alias-border-l4, rgba(128,128,128,0.2))',
  borderRadius: '16px',
  fontSize: '13px',
}

export const header: CSSProperties = {
  display: 'flex',
  alignItems: 'stretch',
  gap: '8px',
  minWidth: 0,
}

export const headerToggle: CSSProperties = {
  display: 'flex',
  flex: '1 1 auto',
  alignItems: 'stretch',
  gap: '8px',
  minWidth: 0,
  padding: 0,
  border: 0,
  background: 'transparent',
  color: 'inherit',
  font: 'inherit',
  textAlign: 'left',
  cursor: 'pointer',
}

export const headerCopy: CSSProperties = {
  display: 'flex',
  flex: '1 1 auto',
  flexDirection: 'column',
  justifyContent: 'center',
  gap: '2px',
  minWidth: 0,
}

export const headerTitle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  minWidth: 0,
  color: 'var(--dsw-alias-label-primary, inherit)',
  fontSize: '14px',
  lineHeight: '22px',
  fontWeight: 500,
}

export const headerTag: CSSProperties = { flex: '0 0 auto', display: 'inline-flex' }

export const headerSummary: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  minWidth: 0,
  overflow: 'hidden',
  color: 'var(--dsw-alias-label-tertiary, #6b7280)',
  fontSize: '12px',
  lineHeight: '18px',
}

export const chevron: CSSProperties = {
  display: 'flex',
  flex: '0 0 auto',
  alignItems: 'center',
  justifyContent: 'center',
  lineHeight: 0,
  color: 'var(--dsw-alias-label-tertiary, #6b7280)',
  transition: 'transform 120ms ease',
}

export const note: CSSProperties = { margin: 0, color: muted }
export const body: CSSProperties = { display: 'flex', flexDirection: 'column', gap: '12px', minWidth: 0 }
export const intro: CSSProperties = { display: 'flex', flexDirection: 'column', gap: '4px' }
export const title: CSSProperties = { fontWeight: 600, color: 'var(--dsw-alias-label-primary, inherit)' }
export const row: CSSProperties = { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', minWidth: 0 }
export const field: CSSProperties = { display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: '5px', minWidth: 0 }

export const actions: CSSProperties = {
  ...row,
  paddingTop: '10px',
  borderTop: `0.5px solid ${border}`,
}

export const errorText: CSSProperties = { margin: 0, color: error }
export const mutedText: CSSProperties = { color: muted }

/** 模型目录契约：此处说明 provider、协议、目录覆盖和用户条目保留。 */
export const modelList: CSSProperties = {
  boxSizing: 'border-box',
  display: 'flex',
  flexDirection: 'column',
  minWidth: 0,
  minHeight: 0,
  maxHeight: '360px',
  overflowY: 'auto',
  padding: '4px 6px 4px 10px',
  border: `0.5px solid ${border}`,
  borderRadius: '10px',
  '--dsh-scrollbar-thumb': 'var(--dsw-alias-scrollbar-bg-l2)',
  '--dsh-scrollbar-thumb-hover': 'var(--dsw-alias-scrollbar-hover-l2)',
} as CSSProperties

export const group: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '4px',
  minWidth: 0,
  padding: '8px 0',
  borderTop: `1px solid ${border}`,
}

export const groupTitle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  minWidth: 0,
  color: 'var(--dsw-alias-label-primary, inherit)',
  fontWeight: 600,
}

export const checkboxRow: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  minWidth: 0,
  padding: '4px 0',
  cursor: 'pointer',
}

export const checkboxLabel: CSSProperties = {
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

export const staleBox: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '7px',
  padding: '10px 12px',
  border: `1px solid ${border}`,
  borderRadius: '8px',
  background: 'rgba(128,128,128,0.08)',
}

export const staleLine: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '8px',
  minWidth: 0,
}

export const staleName: CSSProperties = {
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}
