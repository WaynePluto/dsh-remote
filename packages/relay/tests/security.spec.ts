import type { IncomingMessage } from 'node:http'
import { describe, expect, it } from 'vitest'
import {
  checkBrowserRequest,
  isPublicDomainHost,
} from '../src/http/security.js'
import { resolveRelayConfig } from '../src/config.js'

const config = resolveRelayConfig({
  publicDomain: 'dsh.test',
  directSlug: 'pc1',
  publicScheme: 'https',
})

function request(host: string, origin?: string, remoteAddress = '127.0.0.1'): IncomingMessage {
  return {
    headers: {
      host,
      ...origin === undefined ? {} : { origin },
    },
    socket: { remoteAddress },
  } as unknown as IncomingMessage
}

describe('browser route security', () => {
  it('uses HTTP Origin for the real loopback direct route while keeping public HTTPS', () => {
    expect(checkBrowserRequest(
      request('127.0.0.1:30809', 'http://127.0.0.1:30809'),
      config,
    )).toMatchObject({ ok: true, slug: 'pc1', authority: '127.0.0.1:30809' })

    expect(checkBrowserRequest(
      request('127.0.0.1:30809', 'https://127.0.0.1:30809'),
      config,
    )).toMatchObject({ ok: false, status: 403 })
    expect(checkBrowserRequest(
      request('127.0.0.1:30809', 'http://127.0.0.1:30809', '192.168.1.10'),
      config,
    )).toMatchObject({ ok: false, status: 403 })

    expect(checkBrowserRequest(
      request('pc1.dsh.test', 'https://pc1.dsh.test'),
      config,
    )).toMatchObject({ ok: true, slug: 'pc1', authority: 'pc1.dsh.test' })
  })

  it('recognizes only the configured apex as the management authority', () => {
    expect(isPublicDomainHost('dsh.test', config)).toBe(true)
    expect(isPublicDomainHost('pc1.dsh.test', config)).toBe(false)
    expect(isPublicDomainHost('other.test', config)).toBe(false)
  })
})
