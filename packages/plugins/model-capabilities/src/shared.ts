/** 共享的模型能力形状与校验。 */

export const NAMESPACE = 'dsh-plugin-model-capabilities'
export const PI_AI_NAMESPACE = 'llm-pi-ai'

/** 模型目录契约：此处说明 provider、协议、目录覆盖和用户条目保留。 */
export const SUPPORTED_APIS = [
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
] as const
export type SupportedApi = typeof SUPPORTED_APIS[number]

/** 模型目录契约：此处说明 provider、协议、目录覆盖和用户条目保留。 */
export interface ProtocolOverrideSettings {
  readonly protocolOverrides?: Readonly<Record<string, Readonly<Record<string, SupportedApi>>>>
}

export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export type ThinkingLevel = typeof THINKING_LEVELS[number]
export type ReasoningEfforts = Partial<Record<ThinkingLevel, string | null>>
export type ReasoningMode = 'inherit' | 'disabled' | 'custom'
export type ImageMode = 'inherit' | 'text' | 'image'

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

export interface ModelEntry {
  id: string
  name?: string
  input?: JsonValue[]
  reasoningEfforts?: false | Record<string, JsonValue>
  [key: string]: JsonValue | undefined
}

export interface ProviderProfile {
  displayName?: string
  models?: ModelEntry[]
  modelOverrides?: Record<string, ModelEntry>
}

export function protocolOverrideOf(
  settings: ProtocolOverrideSettings | undefined,
  route: string,
  modelId: string,
): SupportedApi | undefined {
  return settings?.protocolOverrides?.[route]?.[modelId]
}

export interface PiAiSettings {
  readonly providers?: Readonly<Record<string, ProviderProfile>>
}

export interface CapabilityDraft {
  readonly imageMode: ImageMode
  readonly reasoningMode: ReasoningMode
  readonly efforts: ReasoningEfforts
}

export interface ConfiguredModel {
  readonly route: string
  readonly providerName: string
  readonly model: ModelEntry
}

/** 只有明确且非空的模型列表可安全编辑：`models` 会替换目录。 */
export function configuredModels(settings: PiAiSettings | undefined): readonly ConfiguredModel[] {
  if (settings?.providers === undefined) return []
  return Object.entries(settings.providers).flatMap(([route, profile]) => {
    if (!Array.isArray(profile.models) || profile.models.length === 0) return []
    return profile.models.flatMap((model) => {
      if (typeof model !== 'object' || model === null || typeof model.id !== 'string' || model.id.length === 0) return []
      return [{ route, providerName: profile.displayName?.trim() || route, model }]
    })
  })
}

export function imageModeOf(input: readonly unknown[] | undefined): ImageMode | 'unsupported' {
  if (input === undefined || input.length === 0) return 'inherit'
  if (input.length === 1 && input[0] === 'text') return 'text'
  if (input.length === 2 && input.includes('text') && input.includes('image')) return 'image'
  return 'unsupported'
}

export function inputOf(mode: ImageMode): readonly string[] | undefined {
  if (mode === 'inherit') return undefined
  return mode === 'image' ? ['text', 'image'] : ['text']
}

export function reasoningModeOf(value: ModelEntry['reasoningEfforts']): ReasoningMode | 'unsupported' {
  if (value === undefined) return 'inherit'
  if (value === false) return 'disabled'
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'unsupported'
  return 'custom'
}

export function effortsOf(value: ModelEntry['reasoningEfforts']): ReasoningEfforts {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const result: ReasoningEfforts = {}
  for (const level of THINKING_LEVELS) {
    const wire = value[level]
    if (typeof wire === 'string' || wire === null) result[level] = wire
  }
  return result
}

export function draftOf(model: ModelEntry): CapabilityDraft | undefined {
  const imageMode = imageModeOf(model.input)
  const reasoningMode = reasoningModeOf(model.reasoningEfforts)
  if (imageMode === 'unsupported' || reasoningMode === 'unsupported') return undefined
  return { imageMode, reasoningMode, efforts: effortsOf(model.reasoningEfforts) }
}

export type ReasoningFault = 'emptyEfforts' | 'offOnly' | 'missingWire' | 'emptyOffWire'

/** 写入前匹配 dsh 的 `resolveModelReasoning` 规则。 */
export function reasoningFault(draft: CapabilityDraft): ReasoningFault | undefined {
  if (draft.reasoningMode !== 'custom') return undefined
  const entries = Object.entries(draft.efforts) as Array<[ThinkingLevel, string | null]>
  if (entries.length === 0) return 'emptyEfforts'
  if (!entries.some(([level]) => level !== 'off')) return 'offOnly'
  for (const [level, wire] of entries) {
    if (level !== 'off' && (wire === null || wire.length === 0)) return 'missingWire'
    if (level === 'off' && typeof wire === 'string' && wire.length === 0) return 'emptyOffWire'
  }
  return undefined
}

/** 按稳定 id 修改一个模型，同时保留所有无关字段和其他行。 */
export function patchCapabilities(
  settings: PiAiSettings | undefined,
  route: string,
  modelId: string,
  draft: CapabilityDraft,
): readonly ModelEntry[] | undefined {
  const models = settings?.providers?.[route]?.models
  if (!Array.isArray(models) || models.length === 0) return undefined
  if (models.filter(model => model.id === modelId).length !== 1) return undefined
  if (reasoningFault(draft) !== undefined) return undefined
  return models.map((model) => {
    if (model.id !== modelId) return model
    const next: Record<string, unknown> = { ...model }
    const input = inputOf(draft.imageMode)
    if (input === undefined) delete next.input
    else next.input = input
    if (draft.reasoningMode === 'inherit') delete next.reasoningEfforts
    else if (draft.reasoningMode === 'disabled') next.reasoningEfforts = false
    else next.reasoningEfforts = { ...draft.efforts }
    return next as ModelEntry
  })
}

export function modelCapabilitiesEqual(model: ModelEntry, draft: CapabilityDraft): boolean {
  const current = draftOf(model)
  return current !== undefined
    && JSON.stringify(current) === JSON.stringify(draft)
}
