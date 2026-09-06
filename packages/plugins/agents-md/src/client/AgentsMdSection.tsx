/**
 * The Global instructions settings page.
 *
 * A plain textarea over one file, with an explicit Save. It is deliberately NOT
 * an auto-saving editor: this text is prepended to every conversation on the
 * machine, so a half-typed sentence becoming a standing instruction is a real
 * cost, and the moment of committing to it should be a decision.
 *
 * WHY THE DRAFT IS KEPT ON FAILURE. This repository has been bitten twice by
 * settings pages that threw away what a person had typed when the Host refused
 * a write (docs/02 §8.8). The rule that came out of it applies here even though
 * this page does not use the settings domain at all: validate locally with the
 * SAME function the Host runs, show the error next to the thing that caused it,
 * and never clear the draft on failure.
 *
 * @module @dsh-remote/dsh-plugin-agents-md/client/AgentsMdSection
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { documentFault, MAX_BYTES, utf8Bytes } from '../shared.js'
import type { AgentsMdDocument } from '../shared.js'
import { fill } from './locales.js'
import type { AgentsMdKey } from './locales.js'

/** What this plugin injects into its own registration. */
export interface AgentsMdSectionInjected {
  /** Read the stored file. */
  load: () => Promise<AgentsMdDocument>
  /** Replace the stored file. */
  save: (content: string) => Promise<AgentsMdDocument>
}

/** Everything the component reads. */
export type AgentsMdSectionProps = Partial<AgentsMdSectionInjected> & {
  /** Locale seat bound to this plugin's namespace. */
  t?: (key: AgentsMdKey) => string
}

const page: CSSProperties = { display: 'flex', flexDirection: 'column', gap: '16px', fontSize: '13px' }

const intro: CSSProperties = { display: 'flex', flexDirection: 'column', gap: '4px' }

const label: CSSProperties = { fontWeight: 600 }

const muted: CSSProperties = { color: 'var(--dsw-alias-label-secondary, #6b7280)' }

/**
 * A muted paragraph with no margin of its own.
 *
 * The page is a flex column with its own gap; a `<p>`'s default margin stacks
 * on top of that and doubles every gap it appears in.
 */
const note: CSSProperties = { ...muted, margin: 0 }

const row: CSSProperties = { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }

/**
 * The editor.
 *
 * ⚠️ The monospace stack is written out in full rather than relying on
 * `--dsw-font-mono`: dsh references that variable in four places and defines it
 * in none, so it always falls back — and a fallback of `monospace` alone lands
 * on the browser's default fixed font on Windows (docs/02 §8.6b).
 */
const editor: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  minHeight: '360px',
  resize: 'vertical',
  padding: '10px 12px',
  borderRadius: '8px',
  border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3))',
  // Opaque, not a layer token: in the light theme bg-layer-1/2/3 are all the
  // same white, so a layered token would draw nothing at all (docs/02 §8.6a).
  background: 'var(--dsw-alias-bg-base, transparent)',
  color: 'inherit',
  fontFamily: 'var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
  fontSize: '12px',
  lineHeight: 1.6,
  tabSize: 2,
}

const button: CSSProperties = {
  padding: '6px 12px',
  borderRadius: '8px',
  border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3))',
  background: 'transparent',
  color: 'inherit',
  cursor: 'pointer',
  font: 'inherit',
}

const primary: CSSProperties = {
  ...button,
  borderColor: 'var(--dsw-alias-border-l2, rgba(128,128,128,0.45))',
  fontWeight: 600,
}

const errorStyle: CSSProperties = { color: 'var(--dsw-alias-state-error-primary, #dc2626)' }

const mono: CSSProperties = {
  fontFamily: 'var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
}

/**
 * The page.
 * @param props - injected channel callers, plus the locale seat.
 * @returns the editor, or a short notice while it is loading or unavailable.
 */
export function AgentsMdSection(props: AgentsMdSectionProps): ReactNode {
  const { load, save, t } = props

  const [document_, setDocument] = useState<AgentsMdDocument | undefined>(undefined)
  const [draft, setDraft] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [loadError, setLoadError] = useState<string | undefined>(undefined)
  const [saveError, setSaveError] = useState<string | undefined>(undefined)
  /** Guards against a resolved load overwriting a draft after unmount. */
  const alive = useRef(true)

  useEffect(() => () => { alive.current = false }, [])

  const refresh = useCallback(async (): Promise<void> => {
    if (load === undefined) return
    setLoadError(undefined)
    try {
      const next = await load()
      if (!alive.current) return
      setDocument(next)
      // Reloading is an explicit action, so it is allowed to replace the draft.
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
      // Only now is the draft retired: it is equal to what was stored.
      setDraft(undefined)
      setSaved(true)
    } catch (error: unknown) {
      if (!alive.current) return
      // The draft deliberately survives; see the module comment.
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
      <div style={intro}>
        <div style={label}>{t('title')}</div>
        <p style={note}>{t('intro')}</p>
        <p style={note}>{fill(t('whereNote'), { path: document_.displayPath })}</p>
        <p style={note}>{t('scopeNote')}</p>
      </div>

      {!document_.exists ? <p style={note}>{t('missing')}</p> : null}

      <textarea
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
        <button
          type="button"
          style={primary}
          disabled={busy || !dirty || tooLarge}
          onClick={() => { void commit() }}
        >
          {busy ? t('saving') : t('save')}
        </button>
        <button
          type="button"
          style={button}
          disabled={busy || !dirty}
          onClick={() => { setDraft(undefined); setSaveError(undefined) }}
        >
          {t('revert')}
        </button>
        <button type="button" style={button} disabled={busy} onClick={() => { void refresh() }}>
          {t('reload')}
        </button>
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
