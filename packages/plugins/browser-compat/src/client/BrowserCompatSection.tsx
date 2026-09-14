/** 浏览器错误设置页：只读取当前页面内存中的诊断快照，不写设置或发起 RPC。 */

import { useCallback, useSyncExternalStore, useState, type ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { BrowserCapability, BrowserCompatBridge, BrowserCompatSnapshot, BrowserDiagnosticEntry } from '../shared.js'
import { fill } from './locales.js'
import type { BrowserCompatKey } from './locales.js'

const css = {
  section: 'dshx-browser-compat-section',
  intro: 'dshx-browser-compat-intro',
  capabilitySection: 'dshx-browser-compat-capability-section',
  logSection: 'dshx-browser-compat-log-section',
  headingRow: 'dshx-browser-compat-heading-row',
  headingTitle: 'dshx-browser-compat-heading-title',
  actions: 'dshx-browser-compat-actions',
  muted: 'dshx-browser-compat-muted',
  capabilities: 'dshx-browser-compat-capabilities',
  capability: 'dshx-browser-compat-capability',
  capabilityMain: 'dshx-browser-compat-capability-main',
  capabilityKind: 'dshx-browser-compat-capability-kind',
  capabilityStatus: 'dshx-browser-compat-capability-status',
  entries: 'dshx-browser-compat-entries',
  entry: 'dshx-browser-compat-entry',
  entryHeader: 'dshx-browser-compat-entry-header',
  level: 'dshx-browser-compat-level',
  levelError: 'dshx-browser-compat-level-error',
  levelWarning: 'dshx-browser-compat-level-warning',
  source: 'dshx-browser-compat-source',
  entryTimes: 'dshx-browser-compat-entry-times',
  message: 'dshx-browser-compat-message',
  meta: 'dshx-browser-compat-meta',
  stackDetails: 'dshx-browser-compat-stack-details',
  stack: 'dshx-browser-compat-stack',
  empty: 'dshx-browser-compat-empty',
  copyFailure: 'dshx-browser-compat-copy-failure',
} as const

/** 该插件使用内联样式，避免把通用 tsdown 构建切换到第二套 CSS 资产管线。 */
const STYLES = `
.${css.section} { display:flex; flex-direction:column; gap:18px; width:100%; max-width:760px; color:var(--dsw-alias-label-primary); font-size:13px; }
.${css.intro}, .${css.capabilitySection}, .${css.logSection} { display:flex; flex-direction:column; gap:8px; }
.${css.intro} h3, .${css.headingRow} h4, .${css.intro} p, .${css.empty}, .${css.copyFailure} { margin:0; }
.${css.intro} h3 { font-size:15px; line-height:22px; font-weight:600; }
.${css.intro} p, .${css.muted}, .${css.meta}, .${css.capabilityKind}, .${css.entryTimes} { color:var(--dsw-alias-label-tertiary); }
.${css.intro} p, .${css.empty}, .${css.copyFailure} { line-height:20px; }
.${css.headingRow}, .${css.headingTitle}, .${css.actions}, .${css.entryHeader}, .${css.capabilityMain}, .${css.capabilityStatus}, .${css.meta} { display:flex; align-items:center; }
.${css.headingRow}, .${css.entryHeader} { justify-content:space-between; gap:10px; flex-wrap:wrap; }
.${css.headingTitle} { min-width:0; gap:8px; flex-wrap:wrap; }
.${css.headingRow} h4 { font-size:13px; line-height:20px; font-weight:600; }
.${css.actions} { gap:8px; flex-wrap:wrap; }
.${css.capabilities}, .${css.entries} { display:flex; flex-direction:column; gap:8px; margin:0; padding:0; list-style:none; }
.${css.capability}, .${css.entry} { min-width:0; border:.5px solid var(--dsw-alias-border-l1); border-radius:10px; background:var(--dsw-alias-bg-layer-1); }
.${css.capability} { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:9px 12px; }
.${css.capabilityMain} { min-width:0; gap:8px; flex-wrap:wrap; }
.${css.capabilityMain} code, .${css.source}, .${css.message}, .${css.stack} { font-family:var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); }
.${css.capabilityMain} code, .${css.source} { min-width:0; overflow-wrap:anywhere; }
.${css.capabilityKind} { font-size:12px; }
.${css.capabilityStatus} { flex:none; gap:6px; font-size:12px; white-space:nowrap; }
.${css.capabilityStatus} small { color:var(--dsw-alias-label-tertiary); font-size:11px; }
.${css.capabilityStatus}[data-status='native'] { color:var(--dsw-alias-state-success-primary); }
.${css.capabilityStatus}[data-status='polyfilled'] { color:var(--dsw-alias-state-business-primary); }
.${css.capabilityStatus}[data-status='missing'] { color:var(--dsw-alias-state-error-primary); }
.${css.entry} { display:flex; flex-direction:column; gap:8px; padding:10px 12px; }
.${css.entryHeader} { justify-content:flex-start; }
.${css.entryHeader} > :last-child { margin-left:auto; }
.${css.level} { flex:none; font-size:11px; font-weight:600; }
.${css.levelError} { color:var(--dsw-alias-state-error-primary); }
.${css.levelWarning} { color:var(--dsw-alias-state-warn-primary); }
.${css.source} { color:var(--dsw-alias-label-secondary); font-size:11px; overflow-wrap:anywhere; }
.${css.entryTimes} { font-size:11px; white-space:nowrap; }
.${css.message}, .${css.stack} { margin:0; white-space:pre-wrap; overflow-wrap:anywhere; word-break:break-word; }
.${css.message} { color:var(--dsw-alias-label-primary); font-size:12px; line-height:18px; }
.${css.meta} { gap:10px; flex-wrap:wrap; font-size:11px; line-height:16px; }
.${css.stackDetails} { border-top:.5px solid var(--dsw-alias-border-l2); padding-top:7px; }
.${css.stackDetails} summary { color:var(--dsw-alias-label-secondary); cursor:pointer; font-size:11px; }
.${css.stack} { max-height:180px; margin-top:7px; overflow:auto; color:var(--dsw-alias-label-secondary); font-size:11px; line-height:16px; }
.${css.empty}, .${css.copyFailure} { color:var(--dsw-alias-label-tertiary); }
.${css.copyFailure} { color:var(--dsw-alias-state-error-primary); }
@media (max-width:520px) {
  .${css.capability} { align-items:flex-start; flex-direction:column; }
  .${css.capabilityStatus} { padding-left:0; }
  .${css.entryHeader} > :last-child { margin-left:0; }
}
`

/** 设置页注册时由 client 插件注入的内容。 */
export interface BrowserCompatSectionInjected {
  /** 页面 head 注入的临时诊断桥。 */
  bridge: BrowserCompatBridge | undefined
}

/** 设置槽可能暂时没有拿到早期桥接对象，因此所有注入项都允许缺省。 */
export type BrowserCompatSectionProps = Partial<BrowserCompatSectionInjected> & {
  /** 当前语言的本插件文案。 */
  t?: (key: BrowserCompatKey) => string
}

const EMPTY_SNAPSHOT: BrowserCompatSnapshot = {
  startedAt: 0,
  entries: [],
  capabilities: [],
}

/** 将毫秒时间戳显示成当前浏览器的短时间。 */
function timeOf(timestamp: number): string {
  try { return new Date(timestamp).toLocaleTimeString() } catch { return String(timestamp) }
}

/** 复制失败时仍保留浏览器原生可选文本的轻量回退。 */
async function copyText(value: string): Promise<boolean> {
  const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard
  if (typeof clipboard?.writeText === 'function') {
    try {
      await clipboard.writeText(value)
      return true
    } catch {
      // 普通 HTTP、缺少用户手势或 iOS 权限限制时继续尝试 textarea 回退。
    }
  }

  if (typeof document === 'undefined') return false
  const textarea = document.createElement('textarea')
  textarea.value = value
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.left = '-9999px'
  textarea.style.top = '0'
  document.body.appendChild(textarea)
  textarea.select()
  let copied = false
  try { copied = document.execCommand('copy') } catch { copied = false }
  textarea.remove()
  return copied
}

/** 生成单条日志的完整复制文本；不带原始对象和请求内容。 */
function entryText(entry: BrowserDiagnosticEntry): string {
  const lines = [
    `[${entry.level}] ${entry.source}`,
    `message: ${entry.message}`,
    `first: ${new Date(entry.firstAt).toISOString()}`,
    `last: ${new Date(entry.lastAt).toISOString()}`,
    `count: ${entry.count}`,
  ]
  if (entry.context !== undefined) lines.push(`context: ${entry.context}`)
  if (entry.stack !== undefined) lines.push(`stack:\n${entry.stack}`)
  return lines.join('\n')
}

/** 让能力标识在设置页中保持紧凑，同时不丢失原始 id。 */
function capabilityLabel(capability: BrowserCapability): string {
  return capability.id
}

/** 将当前页面的浏览器错误和能力探测结果显示在设置中。 */
export function BrowserCompatSection(props: BrowserCompatSectionProps): ReactNode {
  const { bridge, t } = props
  const translate = t ?? ((key: BrowserCompatKey): string => key)
  const subscribe = useCallback(
    (listener: () => void) => bridge?.subscribe(listener) ?? (() => {}),
    [bridge],
  )
  const getSnapshot = useCallback(
    () => bridge?.getSnapshot() ?? EMPTY_SNAPSHOT,
    [bridge],
  )
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const [copiedId, setCopiedId] = useState<number | 'all' | undefined>(undefined)
  const [copyFailed, setCopyFailed] = useState(false)

  // oxlint-disable-next-line no-array-sort -- 页面需兼容旧 WebKit，不能依赖 ES2023 toSorted。
  // oxlint-disable-next-line no-array-sort -- 页面需兼容旧 WebKit，不能依赖 ES2023 toSorted。
  const entries = [...snapshot.entries].sort((left, right) =>
    right.lastAt - left.lastAt || right.id - left.id)
  const copy = useCallback(async (value: string, id: number | 'all'): Promise<void> => {
    const ok = await copyText(value)
    setCopiedId(ok ? id : undefined)
    setCopyFailed(!ok)
  }, [])
  const copyAll = useCallback((): void => {
    void copy(entries.map(entryText).join('\n\n'), 'all')
  }, [copy, entries])

  if (t === undefined) return null

  return (
    <section className={css.section}>
      <style>{STYLES}</style>
      <div className={css.intro}>
        <h3>{translate('title')}</h3>
        <p>{translate('intro')}</p>
      </div>

      <section className={css.capabilitySection} aria-labelledby="dsh-browser-capabilities">
        <div className={css.headingRow}>
          <h4 id="dsh-browser-capabilities">{translate('capabilities')}</h4>
          {bridge === undefined ? <span className={css.muted}>{translate('unavailable')}</span> : null}
        </div>
        <ul className={css.capabilities}>
          {snapshot.capabilities.map((capability) => (
            <li className={css.capability} key={capability.id}>
              <span className={css.capabilityMain}>
                <code>{capabilityLabel(capability)}</code>
                <span className={css.capabilityKind}>{translate(capability.kind)}</span>
              </span>
              <span
                className={css.capabilityStatus}
                data-status={capability.status}
              >
                {capability.status === 'native'
                  ? translate('capabilityNative')
                  : capability.status === 'polyfilled'
                    ? translate('capabilityPolyfilled')
                    : translate('capabilityMissing')}
                <small>{capability.required ? translate('capabilityRequired') : translate('capabilityOptional')}</small>
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className={css.logSection} aria-labelledby="dsh-browser-errors">
        <div className={css.headingRow}>
          <div className={css.headingTitle}>
            <h4 id="dsh-browser-errors">{translate('errors')}</h4>
            <span className={css.muted}>{fill(translate('entryCount'), { count: entries.length })}</span>
          </div>
          <div className={css.actions}>
            <Button variant="outline" size="sm" disabled={entries.length === 0} onClick={copyAll}>
              {copiedId === 'all' ? translate('copied') : translate('copy')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={entries.length === 0 || bridge === undefined}
              onClick={() => { bridge?.clear(); setCopiedId(undefined); setCopyFailed(false) }}
            >
              {translate('clear')}
            </Button>
          </div>
        </div>

        {copyFailed ? <p className={css.copyFailure}>{translate('copyFailed')}</p> : null}
        {entries.length === 0
          ? <p className={css.empty} aria-live="polite">{translate('empty')}</p>
          : (
            <ol className={css.entries} aria-live="polite">
              {entries.map((entry, index) => (
                <li className={css.entry} key={entry.id}>
                  <div className={css.entryHeader}>
                    <span className={`${css.level} ${entry.level === 'error' ? css.levelError : css.levelWarning}`}>
                      {entry.level === 'error' ? translate('error') : translate('warning')}
                    </span>
                    <code className={css.source}>{entry.source}</code>
                    <span className={css.entryTimes}>
                      {fill(translate('lastSeen'), { time: timeOf(entry.lastAt) })}
                    </span>
                    <Button variant="outline" size="sm" onClick={() => { void copy(entryText(entry), entry.id) }}>
                      {copiedId === entry.id ? translate('copied') : translate('copy')}
                    </Button>
                  </div>
                  <pre className={css.message}>{entry.message}</pre>
                  <div className={css.meta}>
                    <span>{fill(translate('occurrence'), { count: entry.count })}</span>
                    <span>{fill(translate('firstSeen'), { time: timeOf(entry.firstAt) })}</span>
                    {entry.context === undefined ? null : <span>{fill(translate('context'), { value: entry.context })}</span>}
                  </div>
                  {entry.stack === undefined ? null : (
                    <details className={css.stackDetails} open={index === 0}>
                      <summary>{translate('stack')}</summary>
                      <pre className={css.stack}>{entry.stack}</pre>
                    </details>
                  )}
                </li>
              ))}
            </ol>
          )}
      </section>
    </section>
  )
}
