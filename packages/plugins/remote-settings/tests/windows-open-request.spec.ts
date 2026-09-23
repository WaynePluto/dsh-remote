import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { dirname } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { presetDirectoryRequest } from '../src/windows-open-request.js'

const METHOD = 'settings/openAgentPresetDirectory'
function request(id: unknown = 'test-2', host = '127.0.0.1:30809', body?: string) {
  const req = Readable.from([Buffer.from(body ?? JSON.stringify({
    type: 'client-request', rpcId: 'preset-test', method: METHOD, payload: { args: { agentPreset: id } },
  }))]) as IncomingMessage
  req.method = 'POST'
  req.url = `/api/${METHOD}`
  req.headers = { host, connection: 'close' }
  return req
}

function response() {
  const res = Object.assign(new EventEmitter(), {
    destroyed: false, writableEnded: false,
    writeHead: vi.fn(), end: vi.fn<(body?: string) => void>(() => { res.writableEnded = true }),
  })
  return { res: res as unknown as ServerResponse, raw: res,
    body: () => JSON.parse(res.end.mock.calls[0]?.[0] ?? '{}') as { result?: { ok: boolean, value?: { opened: boolean }, error?: { code: string } } },
  }
}

function setup() {
  const resolve = vi.fn(async () => ({ trust: 'user', path: 'C:/host/.agent-presets/test-2/agent.cordis.yml' }))
  const available = vi.fn(() => true)
  const ctx = { agentPresets: { resolve }, settingsController: { canOpenAgentPresetDirectory: available } } as unknown as Context
  const open = vi.fn(async (_path: string, _signal: AbortSignal) => {})
  const next = vi.fn(async () => {})
  return { ctx, resolve, available, open, next }
}

describe('Windows 预设目录请求兼容', () => {
  it.each(['127.0.0.1:30809', '127.0.0.1:30810', 'pc2.example.com'])(
    '所有已认证入口都在目标机器打开，不用 Host 判断同机：%s', async host => {
      const { ctx, open, next, resolve } = setup()
      const { res, raw, body } = response()
      await presetDirectoryRequest(ctx, request('test-2', host), res, next, open, 'win32')
      expect(resolve).toHaveBeenCalledWith('test-2')
      expect(open).toHaveBeenCalledWith(dirname('C:/host/.agent-presets/test-2/agent.cordis.yml'), expect.any(AbortSignal))
      expect(body().result).toEqual({ ok: true, value: { opened: true } })
      expect(raw.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({ 'cache-control': 'no-store' }))
      expect(res.listenerCount('close')).toBe(0)
      expect(next).not.toHaveBeenCalled()
    })

  it.each(['linux', 'darwin', 'other', 'get', 'disabled'] as const)(
    '非 Windows、其它 RPC/方法以及禁用 nativeOpen 时交回原生：%s', async mode => {
      const { ctx, available, open, next } = setup()
      const req = request()
      if (mode === 'other') req.url = '/api/settings/update'
      if (mode === 'get') req.method = 'GET'
      if (mode === 'disabled') available.mockReturnValue(false)
      const { res } = response()
      await presetDirectoryRequest(ctx, req, res, next, open, mode === 'linux' || mode === 'darwin' ? mode : 'win32')
      expect(next).toHaveBeenCalledOnce()
      expect(req.readableEnded).toBe(false)
      expect(open).not.toHaveBeenCalled()
    })

  it.each(['../test', 'C:\\test', '', null, ['test-2']])('拒绝客户端非法 id/路径：%j', async id => {
    const { ctx, resolve, open, next } = setup()
    const { res, body } = response()
    await presetDirectoryRequest(ctx, request(id), res, next, open, 'win32')
    expect(body().result?.error?.code).toBe('gateway/bad-request')
    expect(resolve).not.toHaveBeenCalled()
    expect(open).not.toHaveBeenCalled()
  })

  it('拒绝只读预设，解析失败不调用 opener', async () => {
    const { ctx, resolve, open, next } = setup()
    resolve.mockResolvedValueOnce({ trust: 'system', path: '/system/agent.cordis.yml' })
    const readOnly = response()
    await presetDirectoryRequest(ctx, request(), readOnly.res, next, open, 'win32')
    expect(readOnly.body().result?.error?.code).toBe('agent-preset/read-only')
    resolve.mockRejectedValueOnce(Object.assign(new Error('preset not found'), {
      code: 'agent-preset/not-found', details: { agentPreset: 'test-2', available: [] },
    }))
    const missing = response()
    await presetDirectoryRequest(ctx, request(), missing.res, next, open, 'win32')
    expect(missing.body().result?.error?.code).toBe('agent-preset/not-found')
    expect(open).not.toHaveBeenCalled()
  })

  it.each(['{}', JSON.stringify({ type: 'client-request', rpcId: 'x', method: 'other', payload: {} }), '{', 'x'.repeat(8193)])(
    '拒绝错误信封、method 不匹配、无效 JSON 和超限 body（case %#）', async body => {
      const { ctx, resolve, open, next } = setup()
      const reply = response()
      await presetDirectoryRequest(ctx, request('test-2', undefined, body), reply.res, next, open, 'win32')
      expect(resolve).not.toHaveBeenCalled()
      expect(open).not.toHaveBeenCalled()
      expect(next).not.toHaveBeenCalled()
      expect(reply.raw.end).toHaveBeenCalledOnce()
    })

  it('Content-Length 超限时不读取请求', async () => {
    const { ctx, open, next } = setup()
    const req = request()
    req.headers['content-length'] = '8193'
    const reply = response()
    await presetDirectoryRequest(ctx, req, reply.res, next, open, 'win32')
    expect(reply.raw.writeHead).toHaveBeenCalledWith(413, { connection: 'close' })
    expect(req.readableEnded).toBe(false)
  })

  it('命令失败不能报告 opened:true', async () => {
    const { ctx, open, next } = setup()
    open.mockRejectedValueOnce(new Error('Explorer failed'))
    const { res, body } = response()
    await presetDirectoryRequest(ctx, request(), res, next, open, 'win32')
    expect(body().result?.error?.code).toBe('gateway/internal')
  })

  it('浏览器断开会取消命令并释放监听器，不写入已关闭的响应', async () => {
    const { ctx, open, next } = setup()
    open.mockImplementationOnce((_path, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => { reject(signal.reason) }, { once: true })
    }))
    const { res, raw } = response()
    const operation = presetDirectoryRequest(ctx, request(), res, next, open, 'win32')
    await vi.waitFor(() => { expect(open).toHaveBeenCalledOnce() })
    raw.destroyed = true
    res.emit('close')
    await operation
    expect(open.mock.calls[0]?.[1].aborted).toBe(true)
    expect(raw.end).not.toHaveBeenCalled()
    expect(res.listenerCount('close')).toBe(0)
  })
})
