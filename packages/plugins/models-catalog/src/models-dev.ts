/**
 * Reading models.dev and reducing it to the few facts dsh can actually store.
 *
 * EXTERNAL DATA, PARSED DEFENSIVELY. `api.json` is a third-party document that
 * changes without telling us, so nothing here asserts a shape: every field is
 * probed, a value of the wrong type is dropped, and a model that ends up with
 * nothing but an id still passes (dsh's route defaults will size it). The
 * alternative — a strict schema — turns an upstream field rename into "the
 * button stopped working" instead of "one field went missing".
 *
 * WHAT IS DELIBERATELY NOT READ. models.dev carries no wire protocol, no
 * reasoning-effort spellings, and no compatibility switches, which are exactly
 * the fields `llm-pi-ai` cannot infer for a model its installed catalog does
 * not describe (`packages/llm/llm-pi-ai/src/catalog.ts`). Cost is not read
 * either: dsh zeroes pi-ai's cost metadata and reports no spend.
 *
 * @module @dsh-remote/dsh-plugin-models-catalog/models-dev
 */

import type { Modality, ModelAddition } from './shared.js'

/**
 * Ceiling on the document we will read. The full catalog is a couple of
 * megabytes; anything an order of magnitude past that is either not this
 * document or not something we should hold in memory. Enforced on the bytes
 * actually read, because a server may under-declare or stream.
 */
export const MAX_SOURCE_BYTES = 24 * 1024 * 1024

/** How long one read may take before it is abandoned. */
export const SOURCE_TIMEOUT_MS = 30_000

/** One provider as models.dev describes it, reduced to what we use. */
export interface SourceProvider {
  /** models.dev provider id (its key in the document). */
  id: string
  /** Display name, when stated. */
  name?: string
  /** Model facts by model id, in document order. */
  models: readonly ModelAddition[]
}

/** The whole document, reduced. */
export type SourceCatalog = ReadonlyMap<string, SourceProvider>

/** A record, or undefined for anything else. */
function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** A non-empty string field, or undefined. */
function text(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * A positive integer field, or undefined. Non-integral numbers are dropped
 * rather than rounded: dsh refuses a non-integer capacity, and guessing which
 * way to round someone else's number is not our call.
 */
function capacity(source: Record<string, unknown> | undefined, key: string): number | undefined {
  if (source === undefined) return undefined
  const value = source[key]
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}

/**
 * The modalities dsh accepts, in dsh's own order.
 *
 * models.dev names modalities dsh's seam does not model (`audio`, `video`,
 * `pdf`). They are dropped rather than mapped: `input` is a claim about what
 * the endpoint takes, and over-claiming is the expensive mistake — it admits
 * an attachment the provider then rejects mid-turn, after the message is
 * durable (`packages/llm/llm-pi-ai/src/config.ts`, DEFAULT_INPUT).
 * @param model - one raw model record.
 * @returns the accepted modalities, or undefined when none survive.
 */
function modalities(model: Record<string, unknown>): readonly Modality[] | undefined {
  const input = record(model['modalities'])?.['input']
  if (!Array.isArray(input)) return undefined
  const kept: Modality[] = []
  if (input.includes('text')) kept.push('text')
  if (input.includes('image')) kept.push('image')
  return kept.length === 0 ? undefined : kept
}

/**
 * Reduce one raw model record.
 * @param id - the model's key in the provider's `models` dict.
 * @param raw - the raw record.
 * @returns the addition we could write, or undefined when the record is not one.
 */
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

/**
 * Reduce the whole document.
 * @param document - the parsed JSON.
 * @returns providers by id; a provider with no readable model is omitted.
 */
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

/**
 * Read the body of a response, refusing one that outgrows the ceiling. A
 * declared length is checked first so an honest server is turned away without
 * transferring anything; the accumulated total is what actually enforces the
 * bound. Overflow rejects rather than truncating, because a truncated JSON
 * document is not parseable anyway.
 * @param response - the fetch response.
 * @returns the decoded body text.
 * @throws Error when the body outgrows {@link MAX_SOURCE_BYTES}.
 */
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

/**
 * Fetch and reduce the source document.
 *
 * PLAIN `fetch`, AND THAT IS THE POINT. A machine whose only route out is a
 * proxy configures it once in Settings → Proxy, which points undici's global
 * dispatcher at it for the whole process
 * (`@dsh-remote/dsh-plugin-proxy`). Carrying a proxy option here as well would
 * mean two places to configure, two places to get wrong, and a plugin that
 * reaches the internet when the rest of dsh cannot.
 *
 * The failure message keeps the URL in it because the errors this call fails
 * with — a connect timeout, a TLS refusal — name neither the host nor the
 * reason.
 * @param url - the document to read.
 * @param signal - caller cancellation, joined with this module's own timeout.
 * @returns providers by id.
 * @throws Error naming the URL when the read, the size check, or JSON parsing fails.
 */
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
