/** 进程与运行时契约：此处说明生命周期、身份核验、轮询或终端边界。（涉及：`SettingsScope.mutate`、`packages/client/ui-settings/src/client/settings-scope.ts:132-135`、`catch`） */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Button, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CSSProperties, ReactNode } from 'react'
import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import { DEFAULT_SETTINGS, FIELDS } from '../shared.js'
import type { NotifySettings, NotifyTestResult } from '../shared.js'
import { fill } from './locales.js'
import type { NotifyKey } from './locales.js'

/** 本插件注册时注入的内容。 */
export interface NotifySectionInjected {
  /** 绑定的 `dsh-plugin-notify` settings scope。 */
  scope: SettingsScope<NotifySettings>
  /** 请求宿主立即发送一条通知。 */
  test: () => Promise<NotifyTestResult>
}

/** 组件读取的全部内容。 */
export type NotifySectionProps = Partial<NotifySectionInjected> & {
  /** 绑定到本插件命名空间的 locale 槽位。 */
  t?: (key: NotifyKey) => string
}

const page: CSSProperties = { display: 'flex', flexDirection: 'column', gap: '16px', fontSize: '13px' }

const field: CSSProperties = { display: 'flex', flexDirection: 'column', gap: '4px' }

const label: CSSProperties = { fontWeight: 600 }

const muted: CSSProperties = { color: 'var(--dsw-alias-label-secondary, #6b7280)' }

/** 界面契约：此处说明布局、主题 token、尺寸或 DOM 接缝。（涉及：`<p>`） */
const note: CSSProperties = { ...muted, margin: 0 }

const intro: CSSProperties = { display: 'flex', flexDirection: 'column', gap: '4px' }

const row: CSSProperties = { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }

/** 开关下方的提示，缩进到开关自己的文字列。 */
const hint: CSSProperties = { ...muted, paddingLeft: '44px' }

const errorStyle: CSSProperties = { color: 'var(--dsw-alias-state-error-primary, #dc2626)' }

const okStyle: CSSProperties = { color: 'var(--dsw-alias-state-success-primary, #16a34a)' }

/** 测试契约：此处说明本测试锁定的行为和回归边界。 */
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
  /** 实现说明：此处记录相关接口、边界和生命周期约束。 */
  const committed = useRef<NotifySettings | undefined>(undefined)

  // 来自其他位置的修改（另一个窗口或手工编辑 settings.yaml）
  // 会撤销“Saved.”提示。本页面刚做的修改不属于
  // 这种外部修改；没有例外时，证明保存成功的更新反而会清掉提示
  // 。
  useEffect(() => {
    const echo = committed.current
    if (echo !== undefined && FIELDS.every(key => echo[key] === settings[key])) return
    setSaved(false)
  }, [settings.enabled, settings.waiting])

  /** 设置写入契约：此处说明命名空间、校验、回读确认和草稿保留。 */
  const commit = useCallback(async (key: typeof FIELDS[number], value: boolean): Promise<void> => {
    if (scope === undefined) return
    setFailure(undefined)
    setBusy(true)
    const next: NotifySettings = { ...settings, [key]: value }
    try {
      await scope.mutate([{ op: 'set', path: [key], value }])
      // 实现说明：此处记录相关接口、边界和生命周期约束。（涉及：`catch`）
      // 能诚实回答“是否保存”。
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
        <div style={row}>
          <Switch
            checked={settings.enabled}
            disabled={disabled}
            label={t('enable')}
            title={!writable ? t('readOnly') : undefined}
            onChange={(next) => { void commit('enabled', next) }}
          />
          <span>{t('enable')}</span>
        </div>
        <span style={hint}>{t('enableHint')}</span>
      </div>

      <div style={field}>
        <div style={row}>
          <Switch
            checked={settings.waiting}
            label={t('waiting')}
            // 主开关关闭时子开关没有意义，
            // 一个切换后没有效果的控件看起来就是 bug。
            disabled={disabled || !settings.enabled}
            onChange={(next) => { void commit('waiting', next) }}
          />
          <span>{t('waiting')}</span>
        </div>
        <span style={hint}>{t('waitingHint')}</span>
      </div>

      <div style={row}>
        <Button variant="outline" size="sm" disabled={testing} onClick={() => { void runTest() }}>
          {testing ? t('testing') : t('test')}
        </Button>
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
