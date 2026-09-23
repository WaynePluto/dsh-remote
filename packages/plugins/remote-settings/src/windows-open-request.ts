import { dirname } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { clientRequestSchema } from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-api-settings-controller'
import { openWindowsDirectory } from './windows-directory.js'

const METHOD = 'settings/openAgentPresetDirectory'
const ENDPOINT = `/api/${METHOD}`
const MAX_BODY = 8192
const PRESET_ID = /^[a-z0-9][a-z0-9-]*$/u

type OpenDirectory = (directory: string, signal: AbortSignal) => Promise<void>

function respond(res: ServerResponse, rpcId: string, result: unknown): void {
  if (res.destroyed) return
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify({ type: 'server-response', rpcId, result }))
}

function failure(
  res: ServerResponse, rpcId: string, code: string, message: string, details: unknown = {},
): void {
  respond(res, rpcId, { ok: false, error: { code, message, details } })
}

function presetFailure(error: unknown): { code: string, message: string, details: unknown } | undefined {
  if (!(error instanceof Error) || !('code' in error) || typeof error.code !== 'string'
    || !['agent-preset/not-found', 'agent-preset/invalid'].includes(error.code)) return undefined
  return { code: error.code, message: error.message, details: 'details' in error ? error.details : {} }
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    size += bytes.length
    if (size > MAX_BODY) throw new RangeError('request too large')
    chunks.push(bytes)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}

/** 仅替换 Windows 的预设目录打开命令；请求已通过 dsh 认证及 Host/Origin 校验。 */
export async function presetDirectoryRequest(
  ctx: Context, req: IncomingMessage, res: ServerResponse, next: () => Promise<void>,
  open: OpenDirectory = openWindowsDirectory, platform: NodeJS.Platform = process.platform,
): Promise<void> {
  if (platform !== 'win32' || req.method !== 'POST' || req.url !== ENDPOINT
    || !ctx.settingsController.canOpenAgentPresetDirectory()) {
    await next()
    return
  }
  if (Number(req.headers['content-length']) > MAX_BODY) {
    res.writeHead(413, { connection: 'close' })
    res.end()
    return
  }
  let input: unknown
  try { input = await readBody(req) } catch (error) {
    if (!res.destroyed) {
      res.writeHead(error instanceof RangeError ? 413 : 400, { connection: 'close' })
      res.end('invalid request')
    }
    return
  }
  const envelope = clientRequestSchema.safeParse(input)
  if (!envelope.success || envelope.data.method !== METHOD) {
    failure(res, envelope.success ? envelope.data.rpcId : '', 'gateway/bad-request', 'invalid request envelope')
    return
  }
  const { rpcId, payload } = envelope.data
  if (typeof payload !== 'object' || payload === null || !('args' in payload)
    || typeof payload.args !== 'object' || payload.args === null || !('agentPreset' in payload.args)
    || typeof payload.args.agentPreset !== 'string' || !PRESET_ID.test(payload.args.agentPreset)) {
    failure(res, rpcId, 'gateway/bad-request', 'invalid agent preset id')
    return
  }
  const controller = new AbortController()
  const abort = (): void => { if (!res.writableEnded) controller.abort(new Error('request closed')) }
  res.once('close', abort)
  try {
    if (res.destroyed || req.aborted) controller.abort(new Error('request closed'))
    controller.signal.throwIfAborted()
    const preset = await ctx.agentPresets.resolve(payload.args.agentPreset)
    if (preset.trust !== 'user') {
      failure(res, rpcId, 'agent-preset/read-only', 'this preset ships with the deployment')
      return
    }
    controller.signal.throwIfAborted()
    await open(dirname(preset.path), controller.signal)
    respond(res, rpcId, { ok: true, value: { opened: true } })
  } catch (error) {
    const presetError = presetFailure(error)
    const code = controller.signal.aborted ? 'gateway/cancelled' : presetError?.code ?? 'gateway/internal'
    failure(res, rpcId, code, error instanceof Error ? error.message : 'path open failed', presetError?.details)
  } finally {
    res.off('close', abort)
  }
}
