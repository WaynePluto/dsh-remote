/** 模型目录契约：此处说明 provider、协议、目录覆盖和用户条目保留。（涉及：`.modelAdvanced`） */

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactElement } from 'react'
import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ProviderCardExtrasOwnerProps } from '@deepseek-ai/dsh-client-ui-settings-models/client'
import { createPortal } from 'react-dom'
import type { PiAiSettings, ProtocolOverrideSettings } from '../shared.js'
import type { CapabilityKey } from './locales.js'
import { ModelCapabilityEditor } from './ModelCapabilitiesPanel.js'

interface PortalTarget {
  readonly key: string
  readonly modelId: string
  readonly host: HTMLElement
}

/** 模型目录契约：此处说明 provider、协议、目录覆盖和用户条目保留。 */
const PROVIDER_CARD_SELECTOR = [
  '[class*="_rowCard"]',
  '[class*="_setupCard"]',
  '[class*="_addCard"]',
].join(', ')
const MODEL_CATALOG_SELECTOR = '[class*="_modelCatalog"]'
const MODEL_ENTRY_SELECTOR = '[class*="_modelEntry"]'
const MODEL_ROW_SELECTOR = '[class*="_modelRow"]'
const MODEL_ADVANCED_SELECTOR = '[class*="_modelAdvanced"]'

const unavailableProtocolSnapshot: ConfigFormSnapshot<ProtocolOverrideSettings> = {
  status: 'unavailable',
  value: undefined,
  base: undefined,
  user: undefined,
  revision: undefined,
  writable: false,
  mode: 'memory',
}

const noopSubscribe = (): (() => void) => () => {}

export interface ProviderCapabilitiesPortalProps extends ProviderCardExtrasOwnerProps {
  /** 绑定到 llm-pi-ai 行 entry id 的 config form。 */
  form: ConfigForm<PiAiSettings>
  /** 绑定到本插件 entry id 的协议覆盖 form。 */
  protocolForm?: ConfigForm<ProtocolOverrideSettings>
  t: (key: CapabilityKey) => string
}

function sameTargets(left: readonly PortalTarget[], right: readonly PortalTarget[]): boolean {
  return left.length === right.length && left.every((target, index) => {
    const other = right[index]
    return other !== undefined
      && target.key === other.key
      && target.modelId === other.modelId
      && target.host === other.host
  })
}

/** 模型目录契约：此处说明 provider、协议、目录覆盖和用户条目保留。（涉及：`.modelAdvanced`） */
function targetsOf(card: HTMLElement | null): PortalTarget[] {
  if (card === null) return []
  const catalog = card.querySelector<HTMLElement>(MODEL_CATALOG_SELECTOR)
    ?? card.querySelector<HTMLElement>('section[aria-label="模型目录"], section[aria-label="Models"]')
  if (catalog === null) return []

  const entries = Array.from(catalog.querySelectorAll<HTMLElement>(MODEL_ENTRY_SELECTOR))
  const candidates = entries.length > 0
    ? entries
    : Array.from(catalog.children).filter((child): child is HTMLElement =>
      child instanceof HTMLElement && child.querySelector('button[aria-expanded="true"]') !== null)
  const result: PortalTarget[] = []
  for (const [index, entry] of candidates.entries()) {
    const modelRow = entry.querySelector<HTMLElement>(MODEL_ROW_SELECTOR)
      ?? Array.from(entry.children).find((child): child is HTMLElement =>
        child instanceof HTMLElement
        && child.querySelector('button[aria-expanded="true"]') !== null
        && child.querySelector('input') !== null)
    const disclosure = modelRow?.querySelector<HTMLButtonElement>('button[aria-expanded="true"]')
    if (modelRow === null || modelRow === undefined || disclosure === null) continue
    const id = modelRow.querySelector<HTMLInputElement>('input')?.value.trim()
    if (id === undefined || id.length === 0) continue
    const host = entry.querySelector<HTMLElement>(MODEL_ADVANCED_SELECTOR)
      ?? Array.from(entry.children).find(child => child !== modelRow)
    if (!(host instanceof HTMLElement)) continue
    result.push({ key: `${id}\u0000${String(index)}`, modelId: id, host })
  }
  return result
}

/** 模型目录契约：此处说明 provider、协议、目录覆盖和用户条目保留。 */
export function ProviderCapabilitiesPortal(props: ProviderCapabilitiesPortalProps): ReactElement {
  const anchor = useRef<HTMLSpanElement>(null)
  const [targets, setTargets] = useState<readonly PortalTarget[]>([])
  const snapshot = useSyncExternalStore(
    listener => props.form.subscribe(listener),
    () => props.form.getSnapshot(),
    () => props.form.getSnapshot(),
  )
  const protocolSnapshot = useSyncExternalStore(
    listener => props.protocolForm?.subscribe(listener) ?? noopSubscribe(),
    () => props.protocolForm?.getSnapshot() ?? unavailableProtocolSnapshot,
    () => props.protocolForm?.getSnapshot() ?? unavailableProtocolSnapshot,
  )

  useEffect(() => {
    const card = anchor.current?.closest<HTMLElement>(PROVIDER_CARD_SELECTOR)
      ?? anchor.current?.closest<HTMLElement>('li')
      ?? null
    if (card === null) return
    let timer: ReturnType<typeof setTimeout> | undefined
    let disposed = false
    const scan = (): void => {
      timer = undefined
      if (disposed) return
      const next = targetsOf(card)
      setTargets(current => sameTargets(current, next) ? current : next)
    }
    const schedule = (): void => {
      if (timer !== undefined) return
      timer = setTimeout(scan, 0)
    }
    const observer = new MutationObserver(schedule)
    observer.observe(card, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['aria-expanded'],
    })
    card.addEventListener('input', schedule, true)
    scan()
    return () => {
      disposed = true
      if (timer !== undefined) clearTimeout(timer)
      observer.disconnect()
      card.removeEventListener('input', schedule, true)
    }
  }, [props.provider.provider])

  const models = snapshot.value?.providers?.[props.provider.provider]?.models ?? []
  const modelsById = useMemo(() => new Map(models.map(model => [model.id, model])), [models])
  const writable = snapshot.status === 'ready' && snapshot.writable
    && (props.protocolForm === undefined || (protocolSnapshot.status === 'ready' && protocolSnapshot.writable))

  return (
    <span ref={anchor} data-model-capabilities-anchor="true" style={{ display: 'none' }} aria-hidden="true">
      {targets.map(target => {
        const model = modelsById.get(target.modelId) ?? { id: target.modelId }
        return createPortal(
          <ModelCapabilityEditor
            key={target.key}
            route={props.provider.provider}
            model={model}
            configured={modelsById.has(target.modelId)}
            form={props.form}
            {...props.protocolForm === undefined ? {} : { protocolForm: props.protocolForm }}
            writable={writable}
            t={props.t}
            inline
          />,
          target.host,
          target.key,
        )
      })}
    </span>
  )
}
