import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import {
  SUPPORTED_APIS, THINKING_LEVELS, configuredModels, draftOf, modelCapabilitiesEqual, patchCapabilities,
  protocolOverrideOf, reasoningFault,
} from '../shared.js'
import type {
  CapabilityDraft, ImageMode, ModelEntry, PiAiSettings, ProtocolOverrideSettings, ReasoningEfforts,
  ReasoningMode, SupportedApi, ThinkingLevel,
} from '../shared.js'
import type { CapabilityKey } from './locales.js'
import * as css from './styles.js'

export interface ModelCapabilitiesPanelProps {
  form?: ConfigForm<PiAiSettings>
  protocolForm?: ConfigForm<ProtocolOverrideSettings>
  t?: (key: CapabilityKey) => string
}

const noopSubscribe = (): (() => void) => () => {}

const unavailableProtocolSnapshot: ConfigFormSnapshot<ProtocolOverrideSettings> = {
  status: 'unavailable',
  value: undefined,
  base: undefined,
  user: undefined,
  revision: undefined,
  writable: false,
  mode: 'memory',
}

const unavailableSnapshot: ConfigFormSnapshot<PiAiSettings> = {
  status: 'unavailable',
  value: undefined,
  base: undefined,
  user: undefined,
  revision: undefined,
  writable: false,
  mode: 'memory',
}

function sameDraft(left: CapabilityDraft, right: CapabilityDraft): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function protocolValue(value: string): SupportedApi | undefined {
  return value === '' ? undefined : value as SupportedApi
}

function protocolSettled(
  form: ConfigForm<PiAiSettings>,
  route: string,
  modelId: string,
  configured: boolean,
  expected: SupportedApi | undefined,
): boolean {
  const profile = form.getSnapshot().value?.providers?.[route]
  const actual = configured
    ? profile?.models?.find(model => model.id === modelId)?.api
    : profile?.modelOverrides?.[modelId]?.api
  return actual === expected
}

/** 模型目录契约：此处说明 provider、协议、目录覆盖和用户条目保留。 */
async function waitForProtocol(
  form: ConfigForm<PiAiSettings>,
  route: string,
  modelId: string,
  configured: boolean,
  expected: SupportedApi | undefined,
): Promise<boolean> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (protocolSettled(form, route, modelId, configured, expected)) return true
    // 设置写入契约：协议覆盖先落在本插件行，宿主半再物化到 llm-pi-ai 行。
    // eslint-disable-next-line no-await-in-loop -- 有界轮询等待宿主 volatile 更新
    await new Promise<void>(resolve => { setTimeout(resolve, 10) })
  }
  return protocolSettled(form, route, modelId, configured, expected)
}

export interface ModelCapabilityEditorProps {
  route: string
  model: ModelEntry
  /** 该行是否来自 dsh 明确配置的 models 列表。 */
  configured?: boolean
  form: ConfigForm<PiAiSettings>
  protocolForm?: ConfigForm<ProtocolOverrideSettings>
  writable: boolean
  t: (key: CapabilityKey) => string
  /** 实现说明：此处记录相关接口、边界和生命周期约束。 */
  inline?: boolean
}

export function ModelCapabilityEditor(props: ModelCapabilityEditorProps): ReactNode {
  const initial = draftOf(props.model)
  const configured = props.configured !== false
  const protocolSnapshot = useSyncExternalStore(
    listener => props.protocolForm?.subscribe(listener) ?? noopSubscribe(),
    () => props.protocolForm?.getSnapshot() ?? unavailableProtocolSnapshot,
    () => props.protocolForm?.getSnapshot() ?? unavailableProtocolSnapshot,
  )
  const initialProtocol = protocolOverrideOf(protocolSnapshot.value, props.route, props.model.id)
  const [draft, setDraft] = useState<CapabilityDraft | undefined>(initial)
  const [protocol, setProtocol] = useState<SupportedApi | undefined>(initialProtocol)
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const initialKey = JSON.stringify({ initial, initialProtocol, configured })

  useEffect(() => {
    setDraft(current => current !== undefined && initial !== undefined && !sameDraft(current, initial) ? current : initial)
    setProtocol(current => current !== initialProtocol && current !== undefined ? current : initialProtocol)
    setSaved(false)
  }, [initialKey])

  const shell = props.inline === true ? css.inlineModel : css.model
  if (configured && (draft === undefined || initial === undefined)) {
    return <div style={shell}><div style={css.modelTitle}><strong>{props.model.name ?? props.model.id}</strong><span style={css.modelId}>{props.model.id}</span></div><p style={css.error}>{props.t('unsupported')}</p></div>
  }

  const capabilityDirty = configured && draft !== undefined && initial !== undefined && !sameDraft(draft, initial)
  const protocolDirty = protocol !== initialProtocol
  const dirty = capabilityDirty || protocolDirty
  const fault = configured && draft !== undefined ? reasoningFault(draft) : undefined
  const disabled = !props.writable || busy
  const protocolDisabled = disabled || props.protocolForm === undefined
    || protocolSnapshot.status !== 'ready' || !protocolSnapshot.writable

  const setImageMode = (imageMode: ImageMode): void => {
    setDraft(current => current === undefined ? current : { ...current, imageMode })
    setSaved(false)
    setFailure(undefined)
  }
  const setReasoningMode = (reasoningMode: ReasoningMode): void => {
    setDraft(current => current === undefined ? current : { ...current, reasoningMode })
    setSaved(false)
    setFailure(undefined)
  }
  const toggleEffort = (level: ThinkingLevel): void => {
    setDraft((current) => {
      if (current === undefined) return current
      const efforts: ReasoningEfforts = { ...current.efforts }
      if (Object.hasOwn(efforts, level)) delete efforts[level]
      else efforts[level] = level === 'off' ? null : level
      return { ...current, efforts }
    })
    setSaved(false)
    setFailure(undefined)
  }
  const setWire = (level: ThinkingLevel, value: string): void => {
    setDraft(current => current === undefined ? current : {
      ...current,
      efforts: { ...current.efforts, [level]: level === 'off' && value.length === 0 ? null : value },
    })
    setSaved(false)
    setFailure(undefined)
  }

  // 设置写入契约：dsh 0.1.7 起 ConfigForm.mutate 返回 boolean（false=宿主拒绝），
  // 删除写后回读比对；仅协议覆盖保留有界轮询，等待宿主半把它物化进 llm-pi-ai 行。
  const save = async (): Promise<void> => {
    setBusy(true)
    setFailure(undefined)
    try {
      if (protocolDirty) {
        const protocolForm = props.protocolForm
        if (protocolForm === undefined) {
          setFailure(props.t('rejected'))
          return
        }
        const before = protocolForm.getSnapshot()
        const current = protocolOverrideOf(before.value, props.route, props.model.id)
        if (current !== initialProtocol) {
          setFailure(props.t('disappeared'))
          return
        }
        const path = ['protocolOverrides', props.route, props.model.id]
        const accepted = await protocolForm.mutate(protocol === undefined
          ? [{ op: 'unset', path }]
          : [{ op: 'set', path, value: protocol }], before.revision)
        if (!accepted || !await waitForProtocol(props.form, props.route, props.model.id, configured, protocol)) {
          setFailure(props.t('rejected'))
          return
        }
      }

      if (capabilityDirty && draft !== undefined && initial !== undefined) {
        const before = props.form.getSnapshot()
        const latest = before.value
        const latestModel = latest?.providers?.[props.route]?.models?.find(model => model.id === props.model.id)
        if (latestModel === undefined || !modelCapabilitiesEqual(latestModel, initial)) {
          setFailure(props.t('disappeared'))
          return
        }
        const models = patchCapabilities(latest, props.route, props.model.id, draft)
        if (models === undefined) {
          setFailure(fault === undefined ? props.t('disappeared') : props.t(fault))
          return
        }
        const accepted = await props.form.mutate([{
          // 值来自 JSON settings mirror，patch 只加入 JSON
          // 数组/对象；本地开放模型类型也允许 `undefined`，因此
          // 序列化前可以表达可选字段。
          op: 'set', path: ['providers', props.route, 'models'], value: models.map(model => ({ ...model })) as never,
        }], before.revision)
        if (!accepted) {
          setFailure(props.t('rejected'))
          return
        }
      }
      setSaved(true)
    } catch (error: unknown) {
      setFailure(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <style>{css.selectStyles}</style>
      <div style={shell}>
      {props.inline === true ? <div style={css.inlineTitle}>{props.t('inlineTitle')}</div> : (
        <div style={css.modelTitle}>
          <strong>{props.model.name ?? props.model.id}</strong>
          <span style={css.modelId}>{props.model.id}</span>
        </div>
      )}
      <label style={css.field}>
        <span>{props.t('protocol')}</span>
        <select
          aria-label={props.t('protocol')}
          className={css.selectClass}
          value={protocol ?? ''}
          disabled={protocolDisabled}
          onChange={event => { setProtocol(protocolValue(event.target.value)); setSaved(false); setFailure(undefined) }}
        >
          <option value="">{props.t('protocolInherit')}</option>
          {SUPPORTED_APIS.map(api => <option key={api} value={api}>{props.t(`protocol_${api}` as CapabilityKey)}</option>)}
        </select>
        <span style={css.note}>{props.t('protocolHint')}</span>
      </label>
      {configured && draft !== undefined
        ? (
          <>
            <div style={props.inline === true ? css.inlineFields : { display: 'contents' }}>
              <label style={css.field}>
                <span>{props.t('imageInput')}</span>
                <select aria-label={props.t('imageInput')} className={css.selectClass} value={draft.imageMode} disabled={disabled} onChange={event => { setImageMode(event.target.value as ImageMode) }}>
                  <option value="inherit">{props.t('imageInherit')}</option>
                  <option value="text">{props.t('imageText')}</option>
                  <option value="image">{props.t('imageEnabled')}</option>
                </select>
                <span style={css.note}>{props.t('imageHint')}</span>
              </label>
              <label style={css.field}>
                <span>{props.t('reasoning')}</span>
                <select aria-label={props.t('reasoning')} className={css.selectClass} value={draft.reasoningMode} disabled={disabled} onChange={event => { setReasoningMode(event.target.value as ReasoningMode) }}>
                  <option value="inherit">{props.t('reasoningInherit')}</option>
                  <option value="disabled">{props.t('reasoningDisabled')}</option>
                  <option value="custom">{props.t('reasoningCustom')}</option>
                </select>
                <span style={css.note}>{props.t('reasoningHint')}</span>
              </label>
            </div>
            {draft.reasoningMode === 'custom'
              ? (
                <div style={css.effortGrid}>
                  {THINKING_LEVELS.map((level) => {
                    const enabled = Object.hasOwn(draft.efforts, level)
                    const value = draft.efforts[level]
                    return (
                      <div key={level} style={{ display: 'contents' }}>
                        <label style={css.row}>
                          <input type="checkbox" checked={enabled} disabled={disabled} onChange={() => { toggleEffort(level) }} />
                          <span>{level}</span>
                        </label>
                        <Input
                          aria-label={`${level} ${props.t('wireValue')}`}
                          value={typeof value === 'string' ? value : ''}
                          placeholder={level === 'off' ? props.t('omitParameter') : props.t('wireValue')}
                          disabled={disabled || !enabled}
                          onChange={event => { setWire(level, event.target.value) }}
                        />
                      </div>
                    )
                  })}
                </div>
              )
              : null}
            {fault !== undefined ? <p style={css.error}>{props.t(fault)}</p> : null}
          </>
        )
        : <p style={css.note}>{props.t('protocolOnlyHint')}</p>}
      <div style={css.row}>
        <Button variant="primary" size="sm" disabled={disabled || !dirty || fault !== undefined} onClick={() => { void save() }}>
          {busy ? props.t('saving') : props.t('save')}
        </Button>
        <Button variant="outline" size="sm" disabled={disabled || !dirty} onClick={() => { setDraft(initial); setProtocol(initialProtocol); setFailure(undefined); setSaved(false) }}>
          {props.t('cancel')}
        </Button>
        {dirty ? <span style={css.note}>{props.t('changed')}</span> : null}
        {saved && !dirty ? <span style={css.success}>{props.t('saved')}</span> : null}
      </div>
      {failure !== undefined ? <p style={css.error}>{failure}</p> : null}
      </div>
    </>
  )
}

export function ModelCapabilitiesPanel({ form, protocolForm, t }: ModelCapabilitiesPanelProps): ReactNode {
  const snapshot = useSyncExternalStore(
    listener => form?.subscribe(listener) ?? noopSubscribe(),
    () => form?.getSnapshot() ?? unavailableSnapshot,
    () => form?.getSnapshot() ?? unavailableSnapshot,
  )
  const models = configuredModels(snapshot.value)
  const groups = useMemo(() => {
    const grouped = new Map<string, typeof models>()
    for (const model of models) grouped.set(model.route, [...grouped.get(model.route) ?? [], model])
    return [...grouped.entries()]
  }, [models])

  if (form === undefined || t === undefined) return null
  return (
    <section style={css.panel} aria-label={t('title')}>
      <div><div style={css.title}>{t('title')}</div><p style={css.note}>{t('intro')}</p></div>
      {snapshot.status === 'loading' ? <p style={css.note}>{t('loading')}</p> : null}
      {snapshot.status === 'unavailable' ? <p style={css.error}>{t('unavailable')}</p> : null}
      {snapshot.status === 'ready' && !snapshot.writable ? <p style={css.note}>{t('readOnly')}</p> : null}
      {snapshot.status === 'ready' && groups.length === 0 ? <p style={css.note}>{t('noModels')}</p> : null}
      {groups.map(([route, entries]) => (
        <div style={css.provider} key={route}>
          <div style={css.providerTitle}>{entries[0]?.providerName ?? route}</div>
          {entries.map(entry => (
            <ModelCapabilityEditor
              key={`${route}\u0000${entry.model.id}`}
              route={route}
              model={entry.model}
              form={form}
              {...protocolForm === undefined ? {} : { protocolForm }}
              writable={snapshot.writable}
              t={t}
            />
          ))}
        </div>
      ))}
    </section>
  )
}
