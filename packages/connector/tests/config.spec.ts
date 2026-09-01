import { describe, expect, it } from 'vitest'
import { connectorConfigSchema, resolveConnectorConfig } from '../src/config.js'
import { defaultDeviceKeyPath } from '../src/device-key.js'

const BASE_CONFIG = {
  relayUrl: 'wss://relay.dsh.test',
  machineId: 'machine-01',
  slug: 'pc1',
} as const

describe('connector config', () => {
  it('normalizes browser-facing HTTP schemes to their WebSocket equivalents', () => {
    expect(resolveConnectorConfig({ ...BASE_CONFIG, relayUrl: 'https://relay.dsh.test' })).toMatchObject({
      relayUrl: 'wss://relay.dsh.test',
      dshHost: '127.0.0.1',
      dshPort: 3080,
    })
    expect(resolveConnectorConfig({ ...BASE_CONFIG, relayUrl: 'http://127.0.0.1:8080' }).relayUrl)
      .toBe('ws://127.0.0.1:8080')
  })

  it('rejects relay paths because tunnel endpoints are fixed by the protocol', () => {
    expect(() => resolveConnectorConfig({ ...BASE_CONFIG, relayUrl: 'wss://relay.dsh.test/custom' }))
      .toThrow(/must not contain a path/)
  })

  it('falls back to the per-user device key and leaves enrollment opt-in', () => {
    const config = resolveConnectorConfig(BASE_CONFIG)
    expect(config.deviceKeyPath).toBe(defaultDeviceKeyPath())
    expect(config.enrollToken).toBeUndefined()
    expect(resolveConnectorConfig({ ...BASE_CONFIG, deviceKeyPath: '/tmp/custom.key' }).deviceKeyPath)
      .toBe('/tmp/custom.key')
  })

  it.each([
    [{ ...BASE_CONFIG, slug: 'PC-1' }, /lowercase DNS label/],
    [{ ...BASE_CONFIG, enrollToken: 'too-short' }, />=16 characters/],
    [{ ...BASE_CONFIG, deviceKeyPath: '' }, />=1 characters/],
    [{ ...BASE_CONFIG, dshHost: '192.168.1.10' }, /127\.0\.0\.1/],
    [{ ...BASE_CONFIG, dshPort: 70_000 }, /<=65535/],
  ])('rejects an invalid machine or local-dsh setting', (input, message) => {
    expect(() => connectorConfigSchema.parse(input)).toThrow(message)
  })
})
