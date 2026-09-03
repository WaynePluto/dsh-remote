/**
 * The Notifications settings page.
 *
 * Two switches and a test button. Each switch commits on click — unlike the
 * Proxy page there is nothing to draft, because a boolean cannot be
 * half-entered and the namespace has no validator that could refuse one.
 *
 * ⚠️ A REFUSED WRITE STILL LOOKS LIKE A SUCCESSFUL ONE. `SettingsScope.mutate`
 * RESOLVES when the Host refuses — it reloads the stored document and returns
 * normally (`packages/client/ui-settings/src/client/settings-scope.ts:132-135`),
 * so `catch` never runs and the only visible effect is the switch snapping
 * back. This page therefore reads the stored value back after every write
 * instead of trusting the promise. The case that reaches it here is a read-only
 * settings mirror, which is also announced above the switches.
 *
 * WHY THE TEST BUTTON IS NOT A NICETY. A Windows toast sent under an AppID that
 * is not a registered AUMID can be accepted by the API and never appear. There
 * is no way to observe that from the Host, so the only honest answer to "is
 * this working" is to send one and let the person look at their own screen.
 *
 * @module @dsh-remote/dsh-plugin-notify/client/NotifySection
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import { DEFAULT_SETTINGS, FIELDS } from '../shared.js'
import type { NotifySettings, NotifyTestResult } from '../shared.js'
import { fill } from './locales.js'
import type { NotifyKey } from './locales.js'

/** What this plugin injects into its own registration. */
export interface NotifySectionInjected {
  /** The bound `dsh-plugin-notify` settings scope. */
  scope: SettingsScope<NotifySettings>
  /** Ask the Host to send one notification now. */
  test: () => Promise<NotifyTestResult>
}

/** Everything the component reads. */
export type NotifySectionProps = Partial<NotifySectionInjected> & {
  /** Locale seat bound to this plugin's namespace. */
  t?: (key: NotifyKey) => string
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

const row: CSSProperties = { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }

/** The hint under a switch, indented to the switch's own text column. */
const hint: CSSProperties = { ...muted, paddingLeft: '22px' }

const button: CSSProperties = {
  padding: '6px 12px',
  borderRadius: '8px',
  border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3))',
  background: 'transparent',
  color: 'inherit',
  cursor: 'pointer',
  font: 'inherit',
}

const errorStyle: CSSProperties = { color: 'var(--dsw-alias-state-error-primary, #dc2626)' }

const okStyle: CSSProperties = { color: 'var(--dsw-alias-state-success-primary, #16a34a)' }

/**
 * The page.
 * @param props - injected scope and test caller, plus the locale seat.
 * @returns the page, or a short notice when there is nothing to configure.
 */
export function NotifySection(props: NotifySectionProps): ReactNode {
  const { scope, test, t } = props
  const snapshot: SettingsScopeSnapshot<NotifySettings> | undefined = useSyncExternalStore(
    useCallback((listener: () => void) => scope?.subscribe(listener) ?? (() => {}), [scope]),
    useCallback(() => scope?.getSnapshot(), [scope]),
    useCallback(() => scope?.getSnapshot(), [scope]),
  )

  const settings = snapshot?.value ?? DEFAULT_SETTINGS
  const [busy, setBusy] = useState(false)
  const [testing, setTesting] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [saved, setSaved] = useState(false)
  const [result, setResult] = useState<NotifyTestResult | undefined>(undefined)
  /** The section this page last wrote, so its own echo is not read as an outside edit. */
  const committed = useRef<NotifySettings | undefined>(undefined)

  // An edit from elsewhere (another window, a hand edit of settings.yaml)
  // retires the "Saved." note. The change this page just made itself is not
  // such an edit — without that exception the note is wiped by the very update
  // that proves the write worked.
  useEffect(() => {
    const echo = committed.current
    if (echo !== undefined && FIELDS.every(key => echo[key] === settings[key])) return
    setSaved(false)
  }, [settings.enabled, settings.waiting])

  /**
   * Write one field and confirm it landed.
   * @param key - the field to change.
   * @param value - its new value.
   */
  const commit = useCallback(async (key: typeof FIELDS[number], value: boolean): Promise<void> => {
    if (scope === undefined) return
    setFailure(undefined)
    setBusy(true)
    const next: NotifySettings = { ...settings, [key]: value }
    try {
      await scope.mutate([{ op: 'set', path: [key], value }])
      // Not `catch`: a Host refusal resolves. The stored section is the only
      // honest answer to "did it save".
      const stored = scope.getSnapshot().value
      if (stored === undefined || stored[key] !== value) {
        setFailure(t?.('rejected') ?? 'rejected')
        return
      }
      committed.current = next
      setSaved(true)
    } catch (error: unknown) {
      setFailure(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }, [scope, settings, t])

  const runTest = useCallback(async (): Promise<void> => {
    if (test === undefined) return
    setFailure(undefined)
    setResult(undefined)
    setTesting(true)
    try {
      setResult(await test())
    } catch (error: unknown) {
      setFailure(error instanceof Error ? error.message : String(error))
    } finally {
      setTesting(false)
    }
  }, [test])

  if (t === undefined || scope === undefined) return null
  if (snapshot === undefined || snapshot.status === 'loading') return <p style={note}>{t('loading')}</p>
  if (snapshot.status === 'unavailable') return <p style={note}>{t('unavailable')}</p>

  const writable = snapshot.writable
  const disabled = !writable || busy
  const unsupported = result !== undefined && result.platform !== 'win32'

  return (
    <section style={page}>
      <div style={intro}>
        <div style={label}>{t('title')}</div>
        <p style={note}>{t('intro')}</p>
        <p style={note}>{t('whereNote')}</p>
      </div>

      {!writable ? <p style={note}>{t('readOnly')}</p> : null}

      <div style={field}>
        <label style={row}>
          <input
            type="checkbox"
            checked={settings.enabled}
            disabled={disabled}
            onChange={(event) => { void commit('enabled', event.target.checked) }}
          />
          <span>{t('enable')}</span>
        </label>
        <span style={hint}>{t('enableHint')}</span>
      </div>

      <div style={field}>
        <label style={row}>
          <input
            type="checkbox"
            checked={settings.waiting}
            // The sub-switch is meaningless while the master switch is off, and
            // a control that can be flipped without effect reads as a bug.
            disabled={disabled || !settings.enabled}
            onChange={(event) => { void commit('waiting', event.target.checked) }}
          />
          <span>{t('waiting')}</span>
        </label>
        <span style={hint}>{t('waitingHint')}</span>
      </div>

      <div style={row}>
        <button type="button" style={button} disabled={testing} onClick={() => { void runTest() }}>
          {testing ? t('testing') : t('test')}
        </button>
        {saved ? <span style={muted}>{t('saved')}</span> : null}
      </div>

      {result === undefined
        ? null
        : (
          <span style={result.ok && !unsupported ? okStyle : errorStyle}>
            {unsupported
              ? fill(t('testUnsupported'), { platform: result.platform })
              : result.ok
                ? fill(t('testOk'), { ms: result.elapsedMs })
                : fill(t('testFailed'), { error: result.error ?? '' })}
          </span>
        )}

      {failure !== undefined
        ? <p style={{ ...note, ...errorStyle }}>{fill(t('failed'), { message: failure })}</p>
        : null}
    </section>
  )
}
