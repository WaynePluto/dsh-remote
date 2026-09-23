/** Bundle 详情页中的子代理深度配置表单。 */

import { useCallback, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import {
  DEFAULT_SETTINGS,
  MAX_DEPTH,
} from '../../shared.js'
import type { NAMESPACE, SubagentDepthSettings } from '../../shared.js'
import type { SubagentDepthKey } from './locales.js'
import { DepthSelect } from './DepthSelect.js'

/** 配置组件从注册项取得的 config form。 */
export interface SubagentDepthConfigInjected {
  form: ConfigForm<SubagentDepthSettings>
}

/** Bundle 配置槽运行时属性、语言与设置能力的组合。 */
export type SubagentDepthConfigProps =
  PropsRuntime<'plugins.bundle.config'>
  & PropsLocale<typeof NAMESPACE>
  & InjectFace<SubagentDepthConfigInjected>

const CONFIG_CLASS = 'dshx-subagent-depth-config'
// 对齐 ui-settings-plugins 的 PluginConfigForm 与字段排版，不再绘制第二层卡片。
const CONFIG_STYLES = `
.${CONFIG_CLASS} { display: flex; flex-direction: column; min-width: 0; }
.${CONFIG_CLASS}-status {
  margin: 0 0 12px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 1.5;
}
.${CONFIG_CLASS}-footer {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-top: 16px;
}
.${CONFIG_CLASS}-feedback {
  flex: 1;
  min-width: 0;
  margin: 0;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 1.5;
}
.${CONFIG_CLASS}-feedback[data-state='error'] {
  color: var(--dsw-alias-label-error);
}
`

const localeKeyForDepth = (value: number): SubagentDepthKey => {
  switch (value) {
    case 0: return 'depth0'
    case 1: return 'depth1'
    case 2: return 'depth2'
    case 3: return 'depth3'
    default: return 'depth3'
  }
}

/** 直接渲染 Bundle 配置字段，保留草稿；mutate 的 boolean 回答确认保存。 */
export function SubagentDepthConfig(props: SubagentDepthConfigProps): ReactNode {
  const { form, t, view } = props
  const subscribe = useCallback((listener: () => void) => form.subscribe(listener), [form])
  const getSnapshot = useCallback(() => form.getSnapshot(), [form])
  const snapshot: ConfigFormSnapshot<SubagentDepthSettings> = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const [draft, setDraft] = useState<number | undefined>(undefined)
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)
  const [saved, setSaved] = useState(false)

  // Bundle 配置槽当前只派发 page；显式拒绝其他视图，避免将来重复渲染摘要。
  if (view !== 'page') return null
  if (snapshot.status === 'unavailable') return null
  if (snapshot.status !== 'ready' || snapshot.value === undefined) {
    return (
      <div className={CONFIG_CLASS}>
        <style>{CONFIG_STYLES}</style>
        <p className={`${CONFIG_CLASS}-status`}>{t('loading')}</p>
      </div>
    )
  }

  const settings = snapshot.value ?? DEFAULT_SETTINGS
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
      // dsh 0.1.7 起 mutate 返回 boolean：false 即宿主拒绝，不再需要写后回读比对。
      const accepted = await form.mutate(
        [{ op: 'set', path: ['maxDepth'], value: draft }],
        expectedRevision,
      )
      if (!accepted) {
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

  const feedback = failed
    ? t('saveFailed')
    : saved && !dirty
      ? t('saved')
      : dirty
        ? t('unsaved')
        : ''

  return (
    <div className={CONFIG_CLASS}>
      <style>{CONFIG_STYLES}</style>
      {!snapshot.writable ? <p className={`${CONFIG_CLASS}-status`} role="status">{t('readOnly')}</p> : null}
      <DepthSelect
        label={t('maxDepth')}
        hint={t('hint')}
        labels={Array.from({ length: MAX_DEPTH + 1 }, (_, value) => t(localeKeyForDepth(value)))}
        value={selected}
        disabled={disabled}
        onChange={(value) => {
          setDraft(value)
          setFailed(false)
          setSaved(false)
        }}
      />
      <div className={`${CONFIG_CLASS}-footer`}>
        <p
          className={`${CONFIG_CLASS}-feedback`}
          data-state={failed ? 'error' : undefined}
          role="status"
          aria-live="polite"
        >
          {feedback}
        </p>
        <Button
          variant="outline"
          size="sm"
          disabled={!dirty || saving}
          onClick={() => {
            setDraft(undefined)
            setFailed(false)
            setSaved(false)
          }}
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
}
