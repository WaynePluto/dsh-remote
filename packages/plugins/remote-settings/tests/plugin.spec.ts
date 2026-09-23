import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { apply, inject, name, TRANSPORT_GLOBAL, transportInjection } from '../src/index.js'
import { CHANNEL } from '../src/shared.js'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))

describe('dsh-remote-remote-settings', () => {
  it('contributes exactly the ownsHost global and no transport override', () => {
    const row = transportInjection()
    expect(row).toEqual({ kind: 'global', name: TRANSPORT_GLOBAL, value: { ownsHost: true } })
    // 其他字段会替换页面自己的 HTTP/WebSocket carrier，
    // 而 relay 正是转发这些 carrier。
    expect(Object.keys(row.kind === 'global' ? row.value as object : {})).toEqual(['ownsHost'])
  })

  it('pushes its row onto every collected injection table', () => {
    const listeners = new Map<string, (table: unknown[]) => void>()
    const disposeRpc = vi.fn(async () => {})
    const handle = vi.fn((_channel: string, _handler: unknown) => disposeRpc)
    const effects: Array<() => void> = []
    const ctx = {
      on: vi.fn((event: string, listener: (table: unknown[]) => void) => {
        listeners.set(event, listener)
        return () => listeners.delete(event)
      }),
      connection: { rpc: { handle } },
      effect: (start: () => () => void) => { effects.push(start()) },
    }
    apply(ctx as never)

    // Windows 兼容仅挂认证后的请求层和私有通道，不能增加 relay 标记。
    expect([...listeners.keys()]).toEqual(process.platform === 'win32'
      ? ['webserver/index-inject', 'connection/request'] : ['webserver/index-inject'])
    expect(handle).toHaveBeenCalledTimes(process.platform === 'win32' ? 1 : 0)
    if (process.platform === 'win32') expect(handle.mock.calls[0]?.[0]).toBe(CHANNEL)
    const listener = listeners.get('webserver/index-inject')
    expect(listener).toBeDefined()
    // 每次 render 都是新表：本行必须每次追加，而不是只追加一次。
    for (const table of [[], []]) {
      listener?.(table)
      expect(table).toEqual([transportInjection()])
    }
    for (const dispose of effects.toReversed()) dispose()
    expect(disposeRpc).toHaveBeenCalledTimes(process.platform === 'win32' ? 1 : 0)
  })

  it('等待 Windows 目录兼容使用的原生服务', () => {
    expect(name).toBe('dsh-remote-remote-privileged')
    expect(inject).toEqual(['webServer', 'connection', 'agentPresets', 'settingsController'])
  })

  it('is named by the bundle patch through a package-relative path', () => {
    // dsh 会把 `./` insert 名锚定到 patch 层自身目录，因此
    // patch 绝不能携带绝对路径：绿色包会被解压到
    // 用户指定的位置。
    const patch = readFileSync(join(packageRoot, 'cordis.patch.yml'), 'utf8')
    expect(patch).toContain("name: './dist/index.js'")
    expect(patch).toMatch(/^\s+- id: remote-settings\r?\n\s+name: '\.\/dist\/index\.js'$/mu)
  })

  it('declares the bundle patch and ships it for install', () => {
    const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
      dsh?: { bundle?: { patch?: string }, client?: unknown }
      exports?: Record<string, string>
      files?: string[]
    }
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    expect(manifest.files).toContain('cordis.patch.yml')
    expect(manifest.dsh?.client).toEqual({
      platform: 'web', inject: ['@deepseek-ai/dsh-client-ui-open-in-app'],
    })
    expect(manifest.exports).toHaveProperty('./client', './dist/client.js')
  })
})
