/** models.dev `api.json` 的受限读取和向 pi-ai facts 的投影。 */

import type { Modality, ModelAddition } from './shared.js'

/** source JSON 的最大字节数。 */
export const MAX_SOURCE_BYTES = 24 * 1024 * 1024

/** source fetch 的 timeout。 */
export const SOURCE_TIMEOUT_MS = 30_000

/** models.dev provider 的收窄形状。 */
export interface SourceProvider {
  /** provider 的 id。 */
  id: string
  /** provider 的显示名称。 */
  name?: string
  /** 可添加的 model facts。 */
  models: readonly ModelAddition[]
}

/** provider id 到 facts 的 source catalog。 */
export type SourceCatalog = ReadonlyMap<string, SourceProvider>

/** 从未知 JSON 值读取普通 record。 */
function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** 读取非空字符串字段。 */
function text(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** 读取正整数容量字段。 */
function capacity(source: Record<string, unknown> | undefined, key: string): number | undefined {
  if (source === undefined) return undefined
  const value = source[key]
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}

/** 将 models.dev modalities 收窄到 dsh 接受的 `text`/`image`。 */
function modalities(model: Record<string, unknown>): readonly Modality[] | undefined {
  const input = record(model['modalities'])?.['input']
  if (!Array.isArray(input)) return undefined
  const kept: Modality[] = []
  if (input.includes('text')) kept.push('text')
  if (input.includes('image')) kept.push('image')
  return kept.length === 0 ? undefined : kept
}

/** 从一个 models.dev raw model 读取 ModelAddition。 */
export function readModel(id: string, raw: unknown): ModelAddition | undefined {
  const model = record(raw)
  if (model === undefined || id.length === 0) return undefined
  const limit = record(model['limit'])
  const input = modalities(model)
  const contextWindow = capacity(limit, 'context')
  const maxTokens = capacity(limit, 'output')
  return {
    id,
    name: text(model, 'name') ?? id,
    ...contextWindow === undefined ? {} : { contextWindow },
    ...maxTokens === undefined ? {} : { maxTokens },
    ...input === undefined ? {} : { input },
    ...model['reasoning'] === true ? { reasoningUnavailable: true } : {},
  }
}

/** 从 models.dev JSON 过滤出可用 provider/model catalog。 */
export function readCatalog(document: unknown): SourceCatalog {
  const root = record(document)
  const providers = new Map<string, SourceProvider>()
  if (root === undefined) return providers
  for (const [id, raw] of Object.entries(root)) {
    const provider = record(raw)
    if (provider === undefined) continue
    const models = record(provider['models'])
    if (models === undefined) continue
    const reduced = Object.entries(models)
      .map(([modelId, model]) => readModel(modelId, model))
      .filter((model): model is ModelAddition => model !== undefined)
    if (reduced.length === 0) continue
    const name = text(provider, 'name')
    providers.set(id, { id, ...name === undefined ? {} : { name }, models: reduced })
  }
  return providers
}

/** 有界读取 response body，拒绝超过 source ceiling 的 declared/实际内容。 */
async function readBody(response: Response): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? Number.NaN)
  if (Number.isFinite(declared) && declared > MAX_SOURCE_BYTES) {
    throw new Error(`model source declares ${String(declared)} bytes, past the ${String(MAX_SOURCE_BYTES)} ceiling`)
  }
  const body = response.body
  if (body === null) return ''
  const chunks: Uint8Array[] = []
  let total = 0
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength
    if (total > MAX_SOURCE_BYTES) {
      throw new Error(`model source outgrew the ${String(MAX_SOURCE_BYTES)} byte ceiling`)
    }
    chunks.push(chunk)
  }
  const joined = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    joined.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(joined)
}

/** 通过 fetch + timeout 读取 JSON source，并将 HTTP/parse 错误带回调用方。 */
export async function fetchCatalog(url: string, signal?: AbortSignal): Promise<SourceCatalog> {
  const timeout = AbortSignal.timeout(SOURCE_TIMEOUT_MS)
  const abort = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
  let body: string
  try {
    const response = await fetch(url, { signal: abort, headers: { accept: 'application/json' } })
    if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
    body = await readBody(response)
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`could not read ${url}: ${detail}`, { cause: error })
  }
  try {
    return readCatalog(JSON.parse(body))
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`could not parse ${url}: ${detail}`, { cause: error })
  }
}
