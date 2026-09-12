/** pi-ai provider model maps 的 runtime overlay；支持动态 model 和 per-model API protocol override。 */

import type { Api, Model } from '@earendil-works/pi-ai'
import { AMAZON_BEDROCK_MODELS } from '@earendil-works/pi-ai/providers/amazon-bedrock.models'
import { ANT_LING_MODELS } from '@earendil-works/pi-ai/providers/ant-ling.models'
import { ANTHROPIC_MODELS } from '@earendil-works/pi-ai/providers/anthropic.models'
import { AZURE_OPENAI_RESPONSES_MODELS } from '@earendil-works/pi-ai/providers/azure-openai-responses.models'
import { BASETEN_MODELS } from '@earendil-works/pi-ai/providers/baseten.models'
import { CEREBRAS_MODELS } from '@earendil-works/pi-ai/providers/cerebras.models'
import { CLOUDFLARE_AI_GATEWAY_MODELS } from '@earendil-works/pi-ai/providers/cloudflare-ai-gateway.models'
import { CLOUDFLARE_WORKERS_AI_MODELS } from '@earendil-works/pi-ai/providers/cloudflare-workers-ai.models'
import { DEEPSEEK_MODELS } from '@earendil-works/pi-ai/providers/deepseek.models'
import { FIREWORKS_MODELS } from '@earendil-works/pi-ai/providers/fireworks.models'
import { GITHUB_COPILOT_MODELS } from '@earendil-works/pi-ai/providers/github-copilot.models'
import { GOOGLE_MODELS } from '@earendil-works/pi-ai/providers/google.models'
import { GOOGLE_VERTEX_MODELS } from '@earendil-works/pi-ai/providers/google-vertex.models'
import { GROQ_MODELS } from '@earendil-works/pi-ai/providers/groq.models'
import { HUGGINGFACE_MODELS } from '@earendil-works/pi-ai/providers/huggingface.models'
import { KIMI_CODING_MODELS } from '@earendil-works/pi-ai/providers/kimi-coding.models'
import { MINIMAX_MODELS } from '@earendil-works/pi-ai/providers/minimax.models'
import { MINIMAX_CN_MODELS } from '@earendil-works/pi-ai/providers/minimax-cn.models'
import { MISTRAL_MODELS } from '@earendil-works/pi-ai/providers/mistral.models'
import { MOONSHOTAI_MODELS } from '@earendil-works/pi-ai/providers/moonshotai.models'
import { MOONSHOTAI_CN_MODELS } from '@earendil-works/pi-ai/providers/moonshotai-cn.models'
import { NVIDIA_MODELS } from '@earendil-works/pi-ai/providers/nvidia.models'
import { OPENAI_MODELS } from '@earendil-works/pi-ai/providers/openai.models'
import { OPENAI_CODEX_MODELS } from '@earendil-works/pi-ai/providers/openai-codex.models'
import { OPENCODE_MODELS } from '@earendil-works/pi-ai/providers/opencode.models'
import { OPENCODE_GO_MODELS } from '@earendil-works/pi-ai/providers/opencode-go.models'
import { OPENROUTER_MODELS } from '@earendil-works/pi-ai/providers/openrouter.models'
import { QWEN_TOKEN_PLAN_MODELS } from '@earendil-works/pi-ai/providers/qwen-token-plan.models'
import { QWEN_TOKEN_PLAN_CN_MODELS } from '@earendil-works/pi-ai/providers/qwen-token-plan-cn.models'
import { QWEN_TOKEN_PLAN_INDIVIDUAL_MODELS } from '@earendil-works/pi-ai/providers/qwen-token-plan-individual.models'
import { TOGETHER_MODELS } from '@earendil-works/pi-ai/providers/together.models'
import { VERCEL_AI_GATEWAY_MODELS } from '@earendil-works/pi-ai/providers/vercel-ai-gateway.models'
import { XAI_MODELS } from '@earendil-works/pi-ai/providers/xai.models'
import { XIAOMI_MODELS } from '@earendil-works/pi-ai/providers/xiaomi.models'
import { XIAOMI_TOKEN_PLAN_AMS_MODELS } from '@earendil-works/pi-ai/providers/xiaomi-token-plan-ams.models'
import { XIAOMI_TOKEN_PLAN_CN_MODELS } from '@earendil-works/pi-ai/providers/xiaomi-token-plan-cn.models'
import { XIAOMI_TOKEN_PLAN_SGP_MODELS } from '@earendil-works/pi-ai/providers/xiaomi-token-plan-sgp.models'
import { ZAI_MODELS } from '@earendil-works/pi-ai/providers/zai.models'
import { ZAI_CODING_CN_MODELS } from '@earendil-works/pi-ai/providers/zai-coding-cn.models'
import type { RuntimeModelSpec } from './shared.js'

/** provider route 到 model map。 */
type ModelMap = Record<string, Model<Api>>

/** dsh 内置 model maps 的基线 API。 */
const MODEL_MAPS: Readonly<Record<string, ModelMap>> = {
  'amazon-bedrock': AMAZON_BEDROCK_MODELS as unknown as ModelMap,
  'ant-ling': ANT_LING_MODELS as unknown as ModelMap,
  anthropic: ANTHROPIC_MODELS as unknown as ModelMap,
  'azure-openai-responses': AZURE_OPENAI_RESPONSES_MODELS as unknown as ModelMap,
  baseten: BASETEN_MODELS as unknown as ModelMap,
  cerebras: CEREBRAS_MODELS as unknown as ModelMap,
  'cloudflare-ai-gateway': CLOUDFLARE_AI_GATEWAY_MODELS as unknown as ModelMap,
  'cloudflare-workers-ai': CLOUDFLARE_WORKERS_AI_MODELS as unknown as ModelMap,
  deepseek: DEEPSEEK_MODELS as unknown as ModelMap,
  fireworks: FIREWORKS_MODELS as unknown as ModelMap,
  'github-copilot': GITHUB_COPILOT_MODELS as unknown as ModelMap,
  google: GOOGLE_MODELS as unknown as ModelMap,
  'google-vertex': GOOGLE_VERTEX_MODELS as unknown as ModelMap,
  groq: GROQ_MODELS as unknown as ModelMap,
  huggingface: HUGGINGFACE_MODELS as unknown as ModelMap,
  'kimi-coding': KIMI_CODING_MODELS as unknown as ModelMap,
  minimax: MINIMAX_MODELS as unknown as ModelMap,
  'minimax-cn': MINIMAX_CN_MODELS as unknown as ModelMap,
  mistral: MISTRAL_MODELS as unknown as ModelMap,
  moonshotai: MOONSHOTAI_MODELS as unknown as ModelMap,
  'moonshotai-cn': MOONSHOTAI_CN_MODELS as unknown as ModelMap,
  nvidia: NVIDIA_MODELS as unknown as ModelMap,
  openai: OPENAI_MODELS as unknown as ModelMap,
  'openai-codex': OPENAI_CODEX_MODELS as unknown as ModelMap,
  opencode: OPENCODE_MODELS as unknown as ModelMap,
  'opencode-go': OPENCODE_GO_MODELS as unknown as ModelMap,
  openrouter: OPENROUTER_MODELS as unknown as ModelMap,
  'qwen-token-plan': QWEN_TOKEN_PLAN_MODELS as unknown as ModelMap,
  'qwen-token-plan-cn': QWEN_TOKEN_PLAN_CN_MODELS as unknown as ModelMap,
  'qwen-token-plan-individual': QWEN_TOKEN_PLAN_INDIVIDUAL_MODELS as unknown as ModelMap,
  together: TOGETHER_MODELS as unknown as ModelMap,
  'vercel-ai-gateway': VERCEL_AI_GATEWAY_MODELS as unknown as ModelMap,
  xai: XAI_MODELS as unknown as ModelMap,
  xiaomi: XIAOMI_MODELS as unknown as ModelMap,
  'xiaomi-token-plan-ams': XIAOMI_TOKEN_PLAN_AMS_MODELS as unknown as ModelMap,
  'xiaomi-token-plan-cn': XIAOMI_TOKEN_PLAN_CN_MODELS as unknown as ModelMap,
  'xiaomi-token-plan-sgp': XIAOMI_TOKEN_PLAN_SGP_MODELS as unknown as ModelMap,
  zai: ZAI_MODELS as unknown as ModelMap,
  'zai-coding-cn': ZAI_CODING_CN_MODELS as unknown as ModelMap,
}

/** 本插件动态注册的 model ids，供 installed catalog 排除。 */
const runtimeIds = new Map<string, Set<string>>()

/** 每个内置 model 的初始 API，用于清除 override。 */
const baselineApis = new Map<string, Map<string, string>>()
for (const [route, map] of Object.entries(MODEL_MAPS)) {
  baselineApis.set(route, new Map(Object.values(map).map(model => [model.id, model.api])))
}

/** 当前生效的 per-route/per-model API overrides。 */
const activeProtocolOverrides = new Map<string, Map<string, string>>()

/** 供 sibling plugin 使用的 runtime catalog service。 */
export interface ModelCatalogRuntime {
  /** 替换当前 API overrides，并恢复未覆盖 model 的 baseline。 */
  applyProtocolOverrides: (overrides: Readonly<Record<string, Readonly<Record<string, string>>>>) => void
  /** 返回 route 当前 model ids。 */
  modelIds: (route: string) => readonly string[]
  /** 返回 route/model 当前 API protocol。 */
  modelProtocol: (route: string, id: string) => string | undefined
}

/** 读取一个 route 的 model map。 */
export function modelMap(route: string): ModelMap | undefined {
  return MODEL_MAPS[route]
}

/** 判断 model 是否由本插件动态注册。 */
export function isRuntimeModel(route: string, id: string): boolean {
  return runtimeIds.get(route)?.has(id) === true
}

/** 读取当前 route/model 的 live definition。 */
export function liveModel(route: string, id: string): Model<Api> | undefined {
  return modelMap(route)?.[id]
}

/** 应用 per-model protocol overrides，并恢复未覆盖项的原始 API。 */
export function applyProtocolOverrides(
  overrides: Readonly<Record<string, Readonly<Record<string, string>>>>,
): void {
  activeProtocolOverrides.clear()
  for (const [route, map] of Object.entries(overrides)) {
    activeProtocolOverrides.set(route, new Map(Object.entries(map)))
  }
  for (const [route, map] of Object.entries(MODEL_MAPS)) {
    const routeOverrides = activeProtocolOverrides.get(route)
    const defaults = baselineApis.get(route)
    for (const model of Object.values(map)) {
      const override = routeOverrides?.get(model.id)
      const fallback = defaults?.get(model.id)
      if (override !== undefined) model.api = override as Api
      else if (fallback !== undefined) model.api = fallback as Api
    }
  }
}

/** 返回 route 的 model ids。 */
export function modelIds(route: string): readonly string[] {
  return Object.keys(modelMap(route) ?? {})
}

/** 返回指定 model 的 live API。 */
export function modelProtocol(route: string, id: string): string | undefined {
  return liveModel(route, id)?.api
}

/** 创建供 sibling plugin 调用的 runtime service facade。 */
export function createModelCatalogRuntime(): ModelCatalogRuntime {
  return { applyProtocolOverrides, modelIds, modelProtocol }
}

/** 按 route 优先、全局 fallback 查找 model id 的 API。 */
export function catalogApiForId(route: string, id: string): string | undefined {
  const local = modelMap(route)?.[id]
  if (local !== undefined) return local.api
  for (const map of Object.values(MODEL_MAPS)) {
    const model = map[id]
    if (model !== undefined) return model.api
  }
  return undefined
}

/** 根据 model id 前缀推断 fallback API。 */
export function inferredApi(modelId: string): string {
  const id = modelId.toLowerCase()
  if (id.startsWith('gpt-')) return 'openai-responses'
  if (id.startsWith('claude-')) return 'anthropic-messages'
  return 'openai-completions'
}

/** 从 RuntimeModelSpec 构造并注册动态 model；失败时返回 false。 */
export function ensureRuntimeModel(spec: RuntimeModelSpec): boolean {
  const map = modelMap(spec.route)
  if (map === undefined) return false
  if (map[spec.id] !== undefined) return true

  const models = Object.values(map)
  const template = models.find(model => model.api === spec.api) ?? models[0]
  if (template === undefined) return false

  const model = {
    ...template,
    id: spec.id,
    name: spec.name,
    api: spec.api,
    provider: spec.route,
    contextWindow: spec.contextWindow ?? template.contextWindow,
    maxTokens: spec.maxTokens ?? template.maxTokens,
    // runtime model 继承 template 的输入 schema，只覆盖 spec 给出的字段；删除 thinkingLevelMap 以避免错误的 reasoning levels。
    input: spec.input === undefined || spec.input.length === 0 ? [...template.input] : [...spec.input],
    reasoning: false,
  } as Model<Api> & { thinkingLevelMap?: unknown }
  delete model.thinkingLevelMap
  const override = activeProtocolOverrides.get(spec.route)?.get(spec.id)
  if (override !== undefined) model.api = override as Api
  try {
    Object.defineProperty(map, spec.id, { value: model, enumerable: true, configurable: true, writable: true })
  } catch {
    return false
  }
  const defaults = baselineApis.get(spec.route) ?? new Map<string, string>()
  defaults.set(spec.id, spec.api)
  baselineApis.set(spec.route, defaults)
  let ids = runtimeIds.get(spec.route)
  if (ids === undefined) {
    ids = new Set<string>()
    runtimeIds.set(spec.route, ids)
  }
  ids.add(spec.id)
  return true
}

/** 从 persisted provenance 恢复动态 models，返回恢复失败的 specs。 */
export function hydrateRuntimeModels(routes: Readonly<Record<string, { models?: Readonly<Record<string, RuntimeModelSpec>> }>>): readonly RuntimeModelSpec[] {
  const failed: RuntimeModelSpec[] = []
  for (const [route, provenance] of Object.entries(routes)) {
    for (const raw of Object.values(provenance.models ?? {})) {
      const spec = { ...raw, route }
      if (!ensureRuntimeModel(spec)) failed.push(spec)
    }
  }
  return failed
}
