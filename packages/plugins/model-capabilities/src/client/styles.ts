import type { CSSProperties } from 'react'

const borderL1 = 'var(--dsw-alias-border-l1, rgba(128,128,128,0.28))'
const borderL4 = 'var(--dsw-alias-border-l4, rgba(128,128,128,0.2))'
const muted = 'var(--dsw-alias-label-tertiary, #6b7280)'

/** 模型目录契约：此处说明 provider、协议、目录覆盖和用户条目保留。 */
export const panel: CSSProperties = {
  boxSizing: 'border-box', display: 'flex', flexDirection: 'column', gap: '12px', minWidth: 0,
  padding: '12px 14px', border: `0.5px solid ${borderL4}`, borderRadius: '16px', fontSize: '13px',
}
export const title: CSSProperties = { fontSize: '14px', lineHeight: '22px', fontWeight: 500 }
export const note: CSSProperties = { margin: 0, color: muted, lineHeight: '20px' }
export const provider: CSSProperties = { display: 'flex', flexDirection: 'column', gap: '8px', minWidth: 0 }
export const providerTitle: CSSProperties = { fontSize: '14px', lineHeight: '22px', fontWeight: 500 }
export const model: CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: '10px', minWidth: 0,
  padding: '10px 12px', border: `0.5px solid ${borderL4}`, borderRadius: '12px',
}
/** 模型目录契约：此处说明 provider、协议、目录覆盖和用户条目保留。 */
export const inlineModel: CSSProperties = {
  gridColumn: '1 / -1', display: 'flex', flexDirection: 'column', gap: '10px', minWidth: 0,
  padding: '10px 4px 2px', borderTop: `0.5px solid ${borderL1}`,
}
export const inlineTitle: CSSProperties = { fontSize: '12px', lineHeight: '18px', fontWeight: 500, color: muted }
export const inlineFields: CSSProperties = {
  display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '10px', minWidth: 0,
}
export const modelTitle: CSSProperties = { display: 'flex', gap: '8px', alignItems: 'baseline', flexWrap: 'wrap' }
export const modelId: CSSProperties = {
  color: muted, fontFamily: 'var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
}
export const field: CSSProperties = { display: 'flex', flexDirection: 'column', gap: '5px', minWidth: 0 }
export const row: CSSProperties = { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', minWidth: 0 }
/** Match dsh ui-settings-models/src/client/ModelsSection.module.css, including its native select arrow. */
export const selectClass = 'dshx-model-capabilities-select'
export const selectStyles = `
.${selectClass} {
  box-sizing: border-box;
  width: 100%;
  max-width: 240px;
  height: 32px;
  padding: 0 32px 0 10px;
  border: 0.5px solid var(--dsw-alias-border-l4);
  border-radius: 8px;
  font: inherit;
  font-size: 14px;
  line-height: 22px;
  appearance: none;
  background-color: var(--dsw-alias-bg-layer-1);
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12' fill='none'%3E%3Cpath d='M3 4.5L6 7.5L9 4.5' stroke='%2381858C' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 12px center;
  background-size: 12px 12px;
  color: var(--dsw-alias-label-primary);
}

.${selectClass}:focus {
  outline: none;
  border-color: var(--dsw-alias-brand-primary);
}

.${selectClass}:disabled {
  opacity: 0.6;
  cursor: default;
}
`.trim()

export const effortGrid: CSSProperties = { display: 'grid', gridTemplateColumns: 'minmax(70px, auto) minmax(150px, 1fr)', gap: '6px 10px', alignItems: 'center' }

export const error: CSSProperties = { margin: 0, color: 'var(--dsw-alias-state-error-primary, #dc2626)' }
export const success: CSSProperties = { color: 'var(--dsw-alias-state-success-primary, #16a34a)' }
