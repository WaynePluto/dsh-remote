/** 设置写入契约：此处说明命名空间、校验、回读确认和草稿保留。 */

import { useCallback, useState, useSyncExternalStore } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { Button, IconChevronDownOutline14, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import {
  DEFAULT_SETTINGS,
  MAX_DEPTH,
} from '../../shared.js'
import type { NAMESPACE, SubagentDepthSettings } from '../../shared.js'
import type { SubagentDepthKey } from './locales.js'
import { DepthSelect } from './DepthSelect.js'

/** 实现说明：此处记录相关接口、边界和生命周期约束。 */
export interface SubagentDepthCardInjected {
  /** 设置写入契约：此处说明命名空间、校验、回读确认和草稿保留。 */
  scope: SettingsScope<SubagentDepthSettings>
}

/** 设置写入契约：此处说明命名空间、校验、回读确认和草稿保留。 */
export type SubagentDepthCardProps =
  PropsRuntime<'settings.plugin.item'>
  & PropsLocale<typeof NAMESPACE>
  & InjectFace<SubagentDepthCardInjected>

/** 设置写入契约：此处说明命名空间、校验、回读确认和草稿保留。 */
const card: CSSProperties = {
  listStyle: 'none',
  border: '0.5px solid var(--dsw-alias-border-l4)',
  borderColor: 'var(--dsw-alias-border-l4)',
  borderRadius: '16px',
  background: 'var(--dsw-alias-bg-layer-3)',
  transition: 'border-color .16s, background .16s',
}

const cardOpen: CSSProperties = {
  ...card,
  borderColor: 'var(--dsw-alias-label-dimmed)',
  background: 'var(--dsw-alias-bg-layer-2)',
}

const HEADER_CLASS = 'dshx-subagent-depth-header'
const HEADER_FOCUS_STYLES = `
.${HEADER_CLASS}:focus { outline: none; }
.${HEADER_CLASS}:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: -2px;
}
`

const header: CSSProperties = {
  width: '100%',
  appearance: 'none',
  border: 0,
  background: 'none',
  color: 'inherit',
  font: 'inherit',
  textAlign: 'left',
  cursor: 'pointer',

  display: 'flex',
  alignItems: 'stretch',
  gap: '12px',
  padding: '14px 16px',
  borderRadius: '12px',
}

const headText: CSSProperties = {
  flex: 1,
  minWidth: 0,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'stretch',
  gap: '4px',
}

const name: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  fontSize: '15px',
  fontWeight: 600,
  lineHeight: 1.4,
  color: 'var(--dsw-alias-label-primary, inherit)',
}

const description: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  minWidth: 0,
  fontSize: '13px',
  lineHeight: 1.5,
  color: 'var(--dsw-alias-label-tertiary, #6b7280)',
}

const chevron: CSSProperties = {
  flex: 'none',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  lineHeight: 0,
  color: 'var(--dsw-alias-label-tertiary, #6b7280)',
}

const body: CSSProperties = {
  borderTop: '0.5px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3))',
  margin: '0 16px',
  padding: '16px 0 8px',
  display: 'flex',
  flexDirection: 'column',
  gap: '12px',
  fontSize: '13px',
}

const hint: CSSProperties = {
  margin: 0,
  color: 'var(--dsw-alias-label-tertiary, #6b7280)',
  lineHeight: 1.5,
}

const footer: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'flex-end',
  gap: '8px',
  padding: '12px 0 4px',
  borderTop: '0.5px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3))',
}

const muted: CSSProperties = {
  margin: 0,
  color: 'var(--dsw-alias-label-tertiary, #6b7280)',
  lineHeight: 1.5,
}

const error: CSSProperties = {
  ...muted,
  color: 'var(--dsw-alias-state-error-primary, #dc2626)',
}

const localeKeyForDepth = (value: number): SubagentDepthKey => {
  switch (value) {
    case 0: return 'depth0'
    case 1: return 'depth1'
    case 2: return 'depth2'
    case 3: return 'depth3'
    default: return 'depth3'
  }
}

/** 设置写入契约：此处说明命名空间、校验、回读确认和草稿保留。 */
export function SubagentDepthCard(props: SubagentDepthCardProps): ReactNode {
  const { scope, t } = props
  const subscribe = useCallback((listener: () => void) => scope.subscribe(listener), [scope])
  const getSnapshot = useCallback(() => scope.getSnapshot(), [scope])
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const settings = snapshot.value ?? DEFAULT_SETTINGS
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<number | undefined>(undefined)
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)
  const [saved, setSaved] = useState(false)

  if (snapshot.status === 'unavailable') return null
  if (snapshot.status !== 'ready' || snapshot.value === undefined) {
    return <li style={card}><p style={{ ...muted, padding: '14px 16px' }}>{t('loading')}</p></li>
  }

  const selected = draft ?? settings.maxDepth
  const dirty = draft !== undefined && draft !== settings.maxDepth
  const disabled = !snapshot.writable || saving

  const commit = async (): Promise<void> => {
    if (!dirty || draft === undefined || disabled) return
    setSaving(true)
    setFailed(false)
    setSaved(false)
    const expectedRevision = snapshot.revision
    try {
      await scope.mutate(
        [{ op: 'set', path: ['maxDepth'], value: draft }],
        expectedRevision,
      )
      const landed = scope.getSnapshot().value?.maxDepth === draft
      if (!landed) {
        setFailed(true)
        return
      }
      setDraft(undefined)
      setSaved(true)
    } catch {
      setFailed(true)
    } finally {
      setSaving(false)
    }
  }

  return (
    <li style={open ? cardOpen : card}>
      <style>{HEADER_FOCUS_STYLES}</style>
      <button
        className={HEADER_CLASS}
        type="button"
        style={header}
        aria-expanded={open}
        aria-label={`${t(open ? 'collapse' : 'expand')}: ${t('title')}`}
        onClick={() => { setOpen(value => !value) }}
      >
        <span style={headText}>
          <span style={name}>{t('title')}</span>
          <span style={description}>{t('description')}</span>
        </span>
        {dirty
          ? (
            <span style={{ alignSelf: 'center' }}>
              <Tag tone="neutral">{t('unsaved')}</Tag>
            </span>
          )
          : null}
        <span style={{ ...chevron, transform: open ? 'rotate(180deg)' : undefined }}>
          <IconChevronDownOutline14 />
        </span>
      </button>
      {open
        ? (
          <div style={body}>
            {!snapshot.writable ? <p style={muted} role="status">{t('readOnly')}</p> : null}
            <DepthSelect
              label={t('maxDepth')}
              labels={Array.from({ length: MAX_DEPTH + 1 }, (_, value) => t(localeKeyForDepth(value)))}
              value={selected}
              disabled={disabled}
              onChange={(value) => {
                setDraft(value)
                setFailed(false)
                setSaved(false)
              }}
            />
            <p style={hint}>{t('hint')}</p>
            {failed ? <p style={error} role="status">{t('saveFailed')}</p> : null}
            <div style={footer}>
              {saved && !dirty ? <span style={muted} role="status">{t('saved')}</span> : null}
              <Button
                variant="outline"
                size="sm"
                disabled={!dirty || saving}
                onClick={() => { setDraft(undefined); setFailed(false); setSaved(false) }}
              >
                {t('discard')}
              </Button>
              <Button
                variant="primary"
                size="sm"
                disabled={!dirty || disabled}
                onClick={() => { void commit() }}
              >
                {saving ? t('saving') : t('save')}
              </Button>
            </div>
          </div>
        )
        : null}
    </li>
  )
}
