/** 设置写入契约：dsh 0.1.7 起 `ConfigForm.mutate` 返回 boolean（false=宿主拒绝），无需再写后回读比对。 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Button, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CSSProperties, ReactNode } from 'react'
import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import { DEFAULT_SETTINGS, DEFAULT_TEST_URL, proxyFault } from '../shared.js'
import type { ProxySettings, ProxyTestResult } from '../shared.js'
import { fill } from './locales.js'
import type { ProxyKey } from './locales.js'

/** 实现说明：此处记录相关接口、边界和生命周期约束。 */
const FIELDS = ['enabled', 'url', 'bypass'] as const

/** 本插件注册时注入的内容。 */
export interface ProxySectionInjected {
  /** 绑定到本插件 entry id 的 config form。 */
  form: ConfigForm<ProxySettings>
  /** 调用宿主测试端点。 */
  test: (url: string) => Promise<ProxyTestResult>
}

/** 组件读取的全部内容。 */
export type ProxySectionProps = Partial<ProxySectionInjected> & {
  /** 绑定到本插件命名空间的 locale 槽位。 */
  t?: (key: ProxyKey) => string
}

const page: CSSProperties = { display: 'flex', flexDirection: 'column', gap: '16px', fontSize: '13px' }

const field: CSSProperties = { display: 'flex', flexDirection: 'column', gap: '4px' }

const label: CSSProperties = { fontWeight: 600 }

const muted: CSSProperties = { color: 'var(--dsw-alias-label-secondary, #6b7280)' }

/** 界面契约：此处说明布局、主题 token、尺寸或 DOM 接缝。（涉及：`<p>`） */
const note: CSSProperties = { ...muted, margin: 0 }

const intro: CSSProperties = { display: 'flex', flexDirection: 'column', gap: '4px' }

const CONTROL_CLASS = 'dshx-proxy-control'
const CONTROL_ERROR_CLASS = 'dshx-proxy-control-error'
const CONTROL_STYLES = `
.${CONTROL_CLASS} {
  box-sizing: border-box;
  width: 100%;
  height: 32px;
  padding: 0 10px;
  border: 0.5px solid var(--dsw-alias-border-l4);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 13px;
  line-height: 1.5;
}
.${CONTROL_CLASS}:focus {
  outline: none;
  border-color: var(--dsw-alias-brand-primary);
}
.${CONTROL_CLASS}:disabled {
  color: var(--dsw-alias-label-tertiary);
  opacity: 0.6;
  cursor: default;
}
.${CONTROL_ERROR_CLASS} { border-color: var(--dsw-alias-state-error-primary); }
.${CONTROL_CLASS}.${CONTROL_ERROR_CLASS}:focus { border-color: var(--dsw-alias-state-error-primary); }
.${CONTROL_CLASS}[data-multiline] {
  height: auto;
  min-height: 70px;
  padding: 6px 10px;
  resize: vertical;
}
`

const row: CSSProperties = { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }

const errorStyle: CSSProperties = { color: 'var(--dsw-alias-state-error-primary, #dc2626)' }

const okStyle: CSSProperties = { color: 'var(--dsw-alias-state-success-primary, #16a34a)' }

/** 设置写入契约：此处说明命名空间、校验、回读确认和草稿保留。 */
type Busy = 'idle' | 'saving' | 'testing'

/** 测试契约：此处说明本测试锁定的行为和回归边界。 */
export function ProxySection(props: ProxySectionProps): ReactNode {
  const { form, test, t } = props
  const snapshot: ConfigFormSnapshot<ProxySettings> | undefined = useSyncExternalStore(
    useCallback((listener: () => void) => form?.subscribe(listener) ?? (() => {}), [form]),
    useCallback(() => form?.getSnapshot(), [form]),
    useCallback(() => form?.getSnapshot(), [form]),
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
  /** 实现说明：此处记录相关接口、边界和生命周期约束。 */
  const committed = useRef<ProxySettings | undefined>(undefined)

  // 设置写入契约：此处说明命名空间、校验、回读确认和草稿保留。
  // 被其他位置修改时丢弃（另一个窗口或手工
  // 编辑 settings.yaml）。本页面刚做的修改不属于
  // 外部编辑；没有例外时，证明保存成功的更新会清掉“Saved.”提示
  // 。
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

  /** 设置写入契约：mutate 返回 false 即宿主拒绝（dsh 0.1.7 起显式回答，不再需要回读比对）。 */
  const commit = useCallback(async (next: ProxySettings): Promise<void> => {
    if (form === undefined) return
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
      const accepted = await form.mutate(ops)
      if (!accepted) {
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
  }, [form, t, settings])

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

  /** 实现说明：此处记录相关接口、边界和生命周期约束。（涉及：`commit`） */
  const toggle = useCallback((next: boolean): void => {
    void commit({ enabled: next, url, bypass })
  }, [commit, url, bypass])

  if (t === undefined || form === undefined) return null
  if (snapshot === undefined || snapshot.status === 'loading') return <p style={note}>{t?.('loading') ?? ''}</p>
  if (snapshot.status === 'unavailable') return <p style={note}>{t('unavailable')}</p>

  const writable = snapshot.writable
  const disabled = !writable || busy !== 'idle'

  return (
    <section style={page}>
      <style>{CONTROL_STYLES}</style>
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
        <div style={row}>
          <Switch
            checked={settings.enabled}
            disabled={disabled}
            label={t('enable')}
            title={!writable ? t('readOnly') : undefined}
            onChange={toggle}
          />
          <span>{t('enable')}</span>
        </div>
        {!settings.enabled ? <span style={muted}>{t('enableHint')}</span> : null}
      </div>

      <div style={field}>
        <span style={label}>{t('url')}</span>
        <input
          ref={urlRef}
          className={`${CONTROL_CLASS}${needsUrl ? ` ${CONTROL_ERROR_CLASS}` : ''}`}
          type="text"
          value={url}
          aria-invalid={needsUrl}
          placeholder="127.0.0.1:7890"
          aria-label={t('url')}
          disabled={disabled}
          onChange={(event) => { setNeedsUrl(false); setFailure(undefined); edit({ url: event.target.value }) }}
        />
        {/** 实现说明：此处记录相关接口、边界和生命周期约束。 */}
        <span style={needsUrl ? errorStyle : muted}>
          {needsUrl && failure !== undefined ? failure : t('urlHint')}
        </span>
      </div>

      <div style={field}>
        <span style={label}>{t('bypass')}</span>
        <textarea
          className={CONTROL_CLASS}
          data-multiline="true"
          value={bypass}
          aria-label={t('bypass')}
          disabled={disabled}
          onChange={(event) => { edit({ bypass: event.target.value }) }}
        />
        <span style={muted}>{t('bypassHint')}</span>
      </div>

      <div style={row}>
        <Button
          variant="primary"
          size="sm"
          disabled={disabled || !dirty}
          onClick={() => { void commit({ enabled: settings.enabled, url, bypass }) }}
        >
          {busy === 'saving' ? t('saving') : t('save')}
        </Button>
        {saved && !dirty ? <span style={muted}>{t('saved')}</span> : null}
      </div>

      <div style={field}>
        <span style={label}>{t('testUrl')}</span>
        <div style={row}>
          <input
            className={CONTROL_CLASS}
            style={{ flex: '1 1 260px' }}
            type="text"
            value={testUrl}
            aria-label={t('testUrl')}
            disabled={busy !== 'idle'}
            onChange={(event) => { setTestUrl(event.target.value) }}
          />
          <Button variant="outline" size="sm" disabled={busy !== 'idle'} onClick={() => { void runTest() }}>
            {busy === 'testing' ? t('testing') : t('test')}
          </Button>
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
