/** 设置写入契约：此处说明命名空间、校验、回读确认和草稿保留。 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CSSProperties, ReactNode } from 'react'
import { documentFault, MAX_BYTES, utf8Bytes } from '../shared.js'
import type { AgentsMdDocument } from '../shared.js'
import { fill } from './locales.js'
import type { AgentsMdKey } from './locales.js'

/** 实现说明：此处记录相关接口、边界和生命周期约束。 */
export interface AgentsMdSectionInjected {
  /** 实现说明：此处记录相关接口、边界和生命周期约束。 */
  load: () => Promise<AgentsMdDocument>
  /** 实现说明：此处记录相关接口、边界和生命周期约束。 */
  save: (content: string) => Promise<AgentsMdDocument>
}

/** 实现说明：此处记录相关接口、边界和生命周期约束。 */
export type AgentsMdSectionProps = Partial<AgentsMdSectionInjected> & {
  /** 设置写入契约：此处说明命名空间、校验、回读确认和草稿保留。 */
  t?: (key: AgentsMdKey) => string
}

const page: CSSProperties = { display: 'flex', flexDirection: 'column', gap: '16px', fontSize: '13px' }

const intro: CSSProperties = { display: 'flex', flexDirection: 'column', gap: '4px' }

const label: CSSProperties = { fontWeight: 600 }

const muted: CSSProperties = { color: 'var(--dsw-alias-label-secondary, #6b7280)' }

/** 界面契约：此处说明布局、主题 token、尺寸或 DOM 接缝。（涉及：`<p>`） */
const note: CSSProperties = { ...muted, margin: 0 }

const row: CSSProperties = { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }

const EDITOR_CLASS = 'dshx-agents-md-editor'
const EDITOR_STYLES = `
.${EDITOR_CLASS} {
  border: 0.5px solid var(--dsw-alias-border-l4);
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
}
.${EDITOR_CLASS}:focus {
  outline: none;
  border-color: var(--dsw-alias-brand-primary);
}
.${EDITOR_CLASS}:disabled {
  color: var(--dsw-alias-label-tertiary);
  opacity: 0.6;
  cursor: default;
}
`

/** 界面契约：此处说明布局、主题 token、尺寸或 DOM 接缝。（涉及：`--dsw-font-mono`、`monospace`） */
const editor: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  minHeight: '360px',
  resize: 'vertical',
  padding: '10px 12px',
  borderRadius: '8px',

  // 状态样式由 EDITOR_STYLES 的局部 class 管理，避免 inline 属性压过 :focus。
  fontFamily: 'var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
  fontSize: '12px',
  lineHeight: 1.6,
  tabSize: 2,
}

const errorStyle: CSSProperties = { color: 'var(--dsw-alias-state-error-primary, #dc2626)' }

const mono: CSSProperties = {
  fontFamily: 'var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
}

/** 传输契约：此处说明 RPC 端点、路径段、Host/Origin 围栏或认证边界。 */
export function AgentsMdSection(props: AgentsMdSectionProps): ReactNode {
  const { load, save, t } = props

  const [document_, setDocument] = useState<AgentsMdDocument | undefined>(undefined)
  const [draft, setDraft] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [loadError, setLoadError] = useState<string | undefined>(undefined)
  const [saveError, setSaveError] = useState<string | undefined>(undefined)
  /** 设置写入契约：此处说明命名空间、校验、回读确认和草稿保留。 */
  const alive = useRef(true)

  useEffect(() => () => { alive.current = false }, [])

  const refresh = useCallback(async (): Promise<void> => {
    if (load === undefined) return
    setLoadError(undefined)
    try {
      const next = await load()
      if (!alive.current) return
      setDocument(next)
      // 设置写入契约：此处说明命名空间、校验、回读确认和草稿保留。
      setDraft(undefined)
      setSaved(false)
    } catch (error: unknown) {
      if (!alive.current) return
      setLoadError(error instanceof Error ? error.message : String(error))
    }
  }, [load])

  useEffect(() => { void refresh() }, [refresh])

  const stored = document_?.content ?? ''
  const content = draft ?? stored
  const dirty = draft !== undefined && draft !== stored
  const bytes = utf8Bytes(content)
  const tooLarge = documentFault(content) !== undefined

  const commit = useCallback(async (): Promise<void> => {
    if (save === undefined || tooLarge) return
    setSaveError(undefined)
    setBusy(true)
    try {
      const next = await save(content)
      if (!alive.current) return
      setDocument(next)
      // 设置写入契约：此处说明命名空间、校验、回读确认和草稿保留。
      setDraft(undefined)
      setSaved(true)
    } catch (error: unknown) {
      if (!alive.current) return
      // 设置写入契约：此处说明命名空间、校验、回读确认和草稿保留。
      setSaveError(error instanceof Error ? error.message : String(error))
    } finally {
      if (alive.current) setBusy(false)
    }
  }, [save, content, tooLarge])

  if (t === undefined || load === undefined || save === undefined) return null
  if (document_ === undefined) {
    return loadError === undefined
      ? <p style={note}>{t('loading')}</p>
      : <p style={{ ...note, ...errorStyle }}>{fill(t('loadFailed'), { message: loadError })}</p>
  }

  return (
    <section style={page}>
      <style>{EDITOR_STYLES}</style>
      <div style={intro}>
        <div style={label}>{t('title')}</div>
        <p style={note}>{t('intro')}</p>
        <p style={note}>{fill(t('whereNote'), { path: document_.displayPath })}</p>
        <p style={note}>{t('scopeNote')}</p>
      </div>

      {!document_.exists ? <p style={note}>{t('missing')}</p> : null}

      <textarea
        className={EDITOR_CLASS}
        style={editor}
        value={content}
        spellCheck={false}
        placeholder={t('placeholder')}
        disabled={busy}
        onChange={(event) => {
          setDraft(event.target.value)
          setSaved(false)
          setSaveError(undefined)
        }}
      />

      {tooLarge
        ? (
          <span style={errorStyle}>
            {fill(t('tooLarge'), { max: MAX_BYTES })}
          </span>
        )
        : null}

      <div style={row}>
        <Button
          variant="primary"
          size="sm"
          disabled={busy || !dirty || tooLarge}
          onClick={() => { void commit() }}
        >
          {busy ? t('saving') : t('save')}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={busy || !dirty}
          onClick={() => { setDraft(undefined); setSaveError(undefined) }}
        >
          {t('revert')}
        </Button>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => { void refresh() }}>
          {t('reload')}
        </Button>
        <span style={{ ...muted, ...mono }}>{fill(t('size'), { bytes })}</span>
        {dirty ? <span style={muted}>{t('dirty')}</span> : null}
        {saved && !dirty ? <span style={muted}>{t('saved')}</span> : null}
      </div>

      {saveError !== undefined
        ? <p style={{ ...note, ...errorStyle }}>{fill(t('saveFailed'), { message: saveError })}</p>
        : null}

      <p style={note}>{t('restartNote')}</p>
    </section>
  )
}
