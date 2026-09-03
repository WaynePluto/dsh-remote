/**
 * The Proxy settings page.
 *
 * It is a whole `settings.section` rather than a row in General because it
 * owns three fields, a live status line, and a connectivity test — dsh's own
 * guidance reserves `settings.general.item` for a single compact preference.
 *
 * Writes are explicit. The switch commits immediately (it is one bit), while
 * the two text fields are drafted locally and committed by Save: one settings
 * write per keystroke would be both noisy in `settings.yaml` and a stream of
 * validator failures while an address is half-typed.
 *
 * ⚠️ A REFUSED WRITE LOOKS LIKE A SUCCESSFUL ONE unless this page checks.
 * `SettingsScope.mutate` RESOLVES when the Host refuses — it reloads the stored
 * document and returns normally
 * (`packages/client/ui-settings/src/client/settings-scope.ts:132-135`), so
 * `catch` never runs and the only visible effect is every field snapping back
 * to its old value. This page therefore does two things instead of trusting the
 * promise: it applies the shared rules (`proxyFault`) BEFORE writing, so the
 * common mistakes are named where the person can still see what they typed; and
 * it VERIFIES afterwards that the value actually landed, keeping the draft when
 * it did not.
 *
 * @module @dsh-remote/dsh-plugin-proxy/client/ProxySection
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import { DEFAULT_SETTINGS, DEFAULT_TEST_URL, proxyFault } from '../shared.js'
import type { ProxySettings, ProxyTestResult } from '../shared.js'
import { fill } from './locales.js'
import type { ProxyKey } from './locales.js'

/** The section's three fields, in write order. */
const FIELDS = ['enabled', 'url', 'bypass'] as const

/** What this plugin injects into its own registration. */
export interface ProxySectionInjected {
  /** The bound `proxy` settings scope. */
  scope: SettingsScope<ProxySettings>
  /** Call the Host's test endpoint. */
  test: (url: string) => Promise<ProxyTestResult>
}

/** Everything the component reads. */
export type ProxySectionProps = Partial<ProxySectionInjected> & {
  /** Locale seat bound to this plugin's namespace. */
  t?: (key: ProxyKey) => string
}

const page: CSSProperties = { display: 'flex', flexDirection: 'column', gap: '16px', fontSize: '13px' }

const field: CSSProperties = { display: 'flex', flexDirection: 'column', gap: '4px' }

const label: CSSProperties = { fontWeight: 600 }

const muted: CSSProperties = { color: 'var(--dsw-alias-label-secondary, #6b7280)' }

/**
 * A muted paragraph with no margin of its own.
 *
 * The page is a flex column with its own gap; a `<p>`'s default margin stacks
 * on top of that and doubles every gap it appears in.
 */
const note: CSSProperties = { ...muted, margin: 0 }

const intro: CSSProperties = { display: 'flex', flexDirection: 'column', gap: '4px' }

const input: CSSProperties = {
  padding: '6px 10px',
  borderRadius: '8px',
  border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3))',
  background: 'transparent',
  color: 'inherit',
  font: 'inherit',
}

const row: CSSProperties = { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }

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
  border: '1px solid transparent',
  background: 'var(--dsw-alias-button-primary-fill, #1f2937)',
  color: 'var(--dsw-alias-label-primary-inverted, #fff)',
}

const errorStyle: CSSProperties = { color: 'var(--dsw-alias-state-error-primary, #dc2626)' }

const okStyle: CSSProperties = { color: 'var(--dsw-alias-state-success-primary, #16a34a)' }

/** The section's own status, kept apart from the settings snapshot. */
type Busy = 'idle' | 'saving' | 'testing'

/**
 * The page.
 * @param props - injected scope and test caller, plus the locale seat.
 * @returns the page, or a short notice when there is nothing to configure.
 */
export function ProxySection(props: ProxySectionProps): ReactNode {
  const { scope, test, t } = props
  const snapshot: SettingsScopeSnapshot<ProxySettings> | undefined = useSyncExternalStore(
    useCallback((listener: () => void) => scope?.subscribe(listener) ?? (() => {}), [scope]),
    useCallback(() => scope?.getSnapshot(), [scope]),
    useCallback(() => scope?.getSnapshot(), [scope]),
  )

  const settings = snapshot?.value ?? DEFAULT_SETTINGS
  const [draft, setDraft] = useState<{ url: string; bypass: string } | undefined>(undefined)
  const [busy, setBusy] = useState<Busy>('idle')
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [saved, setSaved] = useState(false)
  const [result, setResult] = useState<ProxyTestResult | undefined>(undefined)
  const [testUrl, setTestUrl] = useState(DEFAULT_TEST_URL)
  const [needsUrl, setNeedsUrl] = useState(false)
  const urlRef = useRef<HTMLInputElement>(null)
  /** The section this page last wrote successfully, so its own echo is not read as an outside edit. */
  const committed = useRef<ProxySettings | undefined>(undefined)

  // The stored section is the source of truth until someone types; a draft is
  // discarded when the document changes underneath it (another window, a hand
  // edit of settings.yaml). The change this page just made itself is not such
  // an edit — without that exception the "Saved." note is wiped by the very
  // update that proves the save worked.
  useEffect(() => {
    setDraft(undefined)
    const echo = committed.current
    if (echo !== undefined && FIELDS.every(key => echo[key] === settings[key])) return
    setSaved(false)
  }, [settings.enabled, settings.url, settings.bypass])

  const url = draft?.url ?? settings.url
  const bypass = draft?.bypass ?? settings.bypass
  const dirty = draft !== undefined && (draft.url !== settings.url || draft.bypass !== settings.bypass)

  const edit = useCallback((patch: { url?: string; bypass?: string }) => {
    setSaved(false)
    setDraft(current => ({
      url: patch.url ?? current?.url ?? settings.url,
      bypass: patch.bypass ?? current?.bypass ?? settings.bypass,
    }))
  }, [settings.url, settings.bypass])

  /**
   * Commit one whole intended section.
   *
   * Three guards, in the order that keeps the person's work: refuse locally
   * what the Host would refuse (naming the field, draft untouched); write only
   * the fields that actually differ; then confirm the write landed, because a
   * refused `mutate` resolves like a successful one.
   */
  const commit = useCallback(async (next: ProxySettings): Promise<void> => {
    if (scope === undefined) return
    setFailure(undefined)
    setNeedsUrl(false)

    const fault = proxyFault(next)
    if (fault !== undefined) {
      setFailure(t?.(fault) ?? fault)
      setNeedsUrl(true)
      urlRef.current?.focus()
      return
    }

    const ops = FIELDS
      .filter(key => next[key] !== settings[key])
      .map(key => ({ op: 'set' as const, path: [key], value: next[key] }))
    if (ops.length === 0) {
      setDraft(undefined)
      return
    }

    setBusy('saving')
    try {
      await scope.mutate(ops)
      // Not `catch`: a Host refusal resolves. The stored section is the only
      // honest answer to "did it save".
      const stored = scope.getSnapshot().value
      if (stored === undefined || !FIELDS.every(key => stored[key] === next[key])) {
        setFailure(t?.('rejected') ?? 'rejected')
        return
      }
      committed.current = next
      setDraft(undefined)
      setSaved(true)
    } catch (error: unknown) {
      setFailure(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy('idle')
    }
  }, [scope, t, settings])

  const runTest = useCallback(async (): Promise<void> => {
    if (test === undefined) return
    setFailure(undefined)
    setResult(undefined)
    setBusy('testing')
    try {
      setResult(await test(testUrl))
    } catch (error: unknown) {
      setFailure(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy('idle')
    }
  }, [test, testUrl])

  /**
   * Flip the switch.
   *
   * Switching ON carries the address beside it, because the Host refuses "on
   * with no address" — and on a fresh page that refusal would land on the only
   * action there is to take. `commit` does the refusing now, locally and with
   * the field named, so this is just "the whole section as it would be".
   */
  const toggle = useCallback((next: boolean): void => {
    void commit({ enabled: next, url, bypass })
  }, [commit, url, bypass])

  if (t === undefined || scope === undefined) return null
  if (snapshot === undefined || snapshot.status === 'loading') return <p style={note}>{t?.('loading') ?? ''}</p>
  if (snapshot.status === 'unavailable') return <p style={note}>{t('unavailable')}</p>

  const writable = snapshot.writable
  const disabled = !writable || busy !== 'idle'

  return (
    <section style={page}>
      <div style={intro}>
        <div style={label}>{t('title')}</div>
        <p style={note}>{t('intro')}</p>
        <p style={note}>{t('envNote')}</p>
      </div>

      <p style={note}>
        {settings.enabled && settings.url.length > 0
          ? fill(t('statusVia'), { url: settings.url })
          : t('statusDirect')}
      </p>

      {!writable ? <p style={note}>{t('readOnly')}</p> : null}

      <div style={field}>
        <label style={row}>
          <input
            type="checkbox"
            checked={settings.enabled}
            disabled={disabled}
            onChange={(event) => { toggle(event.target.checked) }}
          />
          <span>{t('enable')}</span>
        </label>
        {!settings.enabled ? <span style={muted}>{t('enableHint')}</span> : null}
      </div>

      <div style={field}>
        <span style={label}>{t('url')}</span>
        <input
          ref={urlRef}
          style={needsUrl ? { ...input, borderColor: 'var(--dsw-alias-state-error-primary, #dc2626)' } : input}
          type="text"
          value={url}
          placeholder="127.0.0.1:7890"
          aria-label={t('url')}
          disabled={disabled}
          onChange={(event) => { setNeedsUrl(false); setFailure(undefined); edit({ url: event.target.value }) }}
        />
        {/* The refusal belongs beside the field it is about. An earlier version
            put it at the very bottom of the page, where nobody connected it to
            the address they had just typed. */}
        <span style={needsUrl ? errorStyle : muted}>
          {needsUrl && failure !== undefined ? failure : t('urlHint')}
        </span>
      </div>

      <div style={field}>
        <span style={label}>{t('bypass')}</span>
        <textarea
          style={{ ...input, minHeight: '56px', resize: 'vertical' }}
          value={bypass}
          aria-label={t('bypass')}
          disabled={disabled}
          onChange={(event) => { edit({ bypass: event.target.value }) }}
        />
        <span style={muted}>{t('bypassHint')}</span>
      </div>

      <div style={row}>
        <button
          type="button"
          style={primary}
          disabled={disabled || !dirty}
          onClick={() => { void commit({ enabled: settings.enabled, url, bypass }) }}
        >
          {busy === 'saving' ? t('saving') : t('save')}
        </button>
        {saved && !dirty ? <span style={muted}>{t('saved')}</span> : null}
      </div>

      <div style={field}>
        <span style={label}>{t('testUrl')}</span>
        <div style={row}>
          <input
            style={{ ...input, flex: '1 1 260px' }}
            type="text"
            value={testUrl}
            aria-label={t('testUrl')}
            disabled={busy !== 'idle'}
            onChange={(event) => { setTestUrl(event.target.value) }}
          />
          <button type="button" style={button} disabled={busy !== 'idle'} onClick={() => { void runTest() }}>
            {busy === 'testing' ? t('testing') : t('test')}
          </button>
        </div>
        {result === undefined
          ? null
          : (
            <span style={result.ok ? okStyle : errorStyle}>
              {result.ok
                ? fill(t('testOk'), {
                  url: result.url,
                  status: result.status ?? 0,
                  ms: result.elapsedMs,
                  via: result.via === null ? t('testDirect') : fill(t('testVia'), { url: result.via }),
                })
                : fill(t('testFailed'), {
                  url: result.url,
                  via: result.via === null ? t('testDirect') : fill(t('testVia'), { url: result.via }),
                  error: result.error ?? '',
                })}
            </span>
          )}
      </div>

      {failure !== undefined && !needsUrl ? <p style={{ ...note, color: 'var(--dsw-alias-state-error-primary, #dc2626)' }}>{fill(t('failed'), { message: failure })}</p> : null}
    </section>
  )
}
