import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import {
  connectorToRelayFrameSchema,
  authFrameSchema,
  authOkFrameSchema,
  controlFrameSchema,
  decodeControlFrame,
  deviceChallengeMessage,
  dshAuthFrameSchema,
  encodeControlFrame,
  errorFrameSchema,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  helloFrameSchema,
  MAX_CONTROL_FRAME_BYTES,
  parseMembership,
  serializeMembership,
  openStreamFrameSchema,
  PROTOCOL_VERSION,
  type ProtocolDecodeError,
  relayToConnectorFrameSchema,
  TUNNEL_CONTROL_PATH,
  TUNNEL_STREAM_PATH,
} from '../src/index.js'

const hello = {
  type: 'hello',
  version: PROTOCOL_VERSION,
  machineId: 'machine-01',
  slug: 'pc-1',
  connectorVersion: '0.0.1',
} as const

const challenge = {
  type: 'challenge',
  version: PROTOCOL_VERSION,
  nonce: '0123456789abcdef0123456789abcdef',
  expiresAt: 1_800_000_000_000,
} as const

const ed25519Auth = {
  type: 'auth',
  version: PROTOCOL_VERSION,
  machineId: hello.machineId,
  nonce: challenge.nonce,
  credential: {
    method: 'ed25519',
    publicKey: 'F'.repeat(43),
    signature: 'S'.repeat(86),
  },
} as const

const enrollAuth = {
  ...ed25519Auth,
  credential: {
    method: 'ed25519-enroll',
    publicKey: 'F'.repeat(43),
    signature: 'S'.repeat(86),
    enrollToken: 'enroll-token-0123456789abcdef',
  },
} as const

const authOk = {
  type: 'auth-ok',
  version: PROTOCOL_VERSION,
  machineId: hello.machineId,
  slug: hello.slug,
  heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
  heartbeatTimeoutMs: HEARTBEAT_TIMEOUT_MS,
} as const

const openStream = {
  type: 'open-stream',
  version: PROTOCOL_VERSION,
  streamId: 'stream-01',
  streamToken: 'stream-token-0123456789abcdef',
  expiresAt: 1_800_000_000_000,
} as const

const dshAuth = {
  type: 'dsh-auth',
  version: PROTOCOL_VERSION,
  token: 'dsh-launch-token-0123456789',
} as const

const ping = {
  type: 'ping',
  version: PROTOCOL_VERSION,
  id: 'heartbeat-01',
  sentAt: 1_700_000_000_000,
} as const

const pong = { ...ping, type: 'pong' } as const

const errorFrame = {
  type: 'error',
  version: PROTOCOL_VERSION,
  code: 'AUTH_FAILED',
  message: 'device signature rejected',
  fatal: true,
} as const

describe('control frame schemas', () => {
  it('accepts every control frame', () => {
    for (const frame of [hello, challenge, ed25519Auth, enrollAuth, authOk, openStream, dshAuth, ping, pong, errorFrame]) {
      expect(controlFrameSchema.parse(frame)).toEqual(frame)
    }
  })

  it('accepts a dsh token only in a URL-safe shape', () => {
    expect(dshAuthFrameSchema.parse(dshAuth)).toEqual(dshAuth)
    for (const token of ['short', 'has spaces in it here', 'slash/and+plus0123456789', '']) {
      expect(dshAuthFrameSchema.safeParse({ ...dshAuth, token }).success).toBe(false)
    }
  })

  it('accepts only Ed25519 credentials now that the static token is gone', () => {
    expect(authFrameSchema.parse(ed25519Auth)).toEqual(ed25519Auth)
    expect(authFrameSchema.parse(enrollAuth)).toEqual(enrollAuth)
    expect(authFrameSchema.safeParse({
      ...ed25519Auth,
      credential: { method: 'token', token: 'static-token-0123456789abcdef' },
    }).success).toBe(false)
  })

  it('rejects keys and signatures that are not raw Ed25519 sizes', () => {
    for (const publicKey of ['F'.repeat(42), 'F'.repeat(44), `${'F'.repeat(42)}=`]) {
      expect(authFrameSchema.safeParse({
        ...ed25519Auth,
        credential: { ...ed25519Auth.credential, publicKey },
      }).success).toBe(false)
    }
    expect(authFrameSchema.safeParse({
      ...ed25519Auth,
      credential: { ...ed25519Auth.credential, signature: 'S'.repeat(85) },
    }).success).toBe(false)
  })

  it('applies heartbeat defaults on auth-ok', () => {
    expect(authOkFrameSchema.parse({
      type: 'auth-ok',
      version: PROTOCOL_VERSION,
      machineId: hello.machineId,
      slug: hello.slug,
    })).toMatchObject({
      heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
      heartbeatTimeoutMs: HEARTBEAT_TIMEOUT_MS,
    })
  })

  it('enforces lowercase DNS-label machine slugs', () => {
    expect(helloFrameSchema.safeParse({ ...hello, slug: 'PC_1' }).success).toBe(false)
    expect(helloFrameSchema.safeParse({ ...hello, slug: '-pc1' }).success).toBe(false)
    expect(helloFrameSchema.safeParse({ ...hello, slug: 'pc1-' }).success).toBe(false)
  })

  it('rejects unknown fields instead of silently stripping them', () => {
    expect(openStreamFrameSchema.safeParse({ ...openStream, targetPort: 22 }).success).toBe(false)
    expect(errorFrameSchema.safeParse({ ...errorFrame, stack: 'secret' }).success).toBe(false)
  })

  it('separates connector-to-relay and relay-to-connector directions', () => {
    expect(connectorToRelayFrameSchema.safeParse(hello).success).toBe(true)
    expect(connectorToRelayFrameSchema.safeParse(openStream).success).toBe(false)
    expect(relayToConnectorFrameSchema.safeParse(openStream).success).toBe(true)
    expect(relayToConnectorFrameSchema.safeParse(hello).success).toBe(false)
  })
})

describe('control frame codec', () => {
  it('round-trips a validated frame', () => {
    expect(decodeControlFrame(encodeControlFrame(ed25519Auth))).toEqual(ed25519Auth)
  })

  it('accepts Buffer, ArrayBuffer, and typed-array WebSocket payloads', () => {
    const json = encodeControlFrame(ping)
    const buffer = Buffer.from(json)
    expect(decodeControlFrame(buffer)).toEqual(ping)
    expect(decodeControlFrame(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength))).toEqual(ping)
    expect(decodeControlFrame(new Uint8Array(buffer))).toEqual(ping)
  })

  it('reports incompatible versions clearly before schema details', () => {
    expect(() => decodeControlFrame(JSON.stringify({ ...hello, version: 1 })))
      .toThrowError(expect.objectContaining<Partial<ProtocolDecodeError>>({
        code: 'UNSUPPORTED_PROTOCOL',
        message: 'unsupported protocol version 1; expected 3',
      }))
  })

  it('reports invalid JSON and invalid frames separately', () => {
    expect(() => decodeControlFrame('{')).toThrowError(
      expect.objectContaining<Partial<ProtocolDecodeError>>({ code: 'INVALID_JSON' }),
    )
    expect(() => decodeControlFrame(JSON.stringify({ type: 'hello', version: PROTOCOL_VERSION }))).toThrowError(
      expect.objectContaining<Partial<ProtocolDecodeError>>({ code: 'INVALID_FRAME' }),
    )
  })

  it('refuses oversized frames before parsing JSON', () => {
    expect(() => decodeControlFrame('x'.repeat(MAX_CONTROL_FRAME_BYTES + 1))).toThrowError(
      expect.objectContaining<Partial<ProtocolDecodeError>>({ code: 'FRAME_TOO_LARGE' }),
    )
  })
})

describe('shared constants', () => {
  it('uses reserved tunnel paths and a positive protocol version', () => {
    expect(PROTOCOL_VERSION).toBe(3)
    expect(TUNNEL_CONTROL_PATH).toBe('/_tunnel/control')
    expect(TUNNEL_STREAM_PATH).toBe('/_tunnel/stream')
  })
})

describe('device challenge message', () => {
  const base = { nonce: 'nonce-value', machineId: 'machine-01', slug: 'pc1' }

  it('is deterministic and domain separated', () => {
    expect(deviceChallengeMessage(base)).toEqual(deviceChallengeMessage({ ...base }))
    expect(Buffer.from(deviceChallengeMessage(base)).toString('utf8'))
      .toContain('dsh-remote/device-challenge/v2')
  })

  it('changes when any bound field changes', () => {
    const original = Buffer.from(deviceChallengeMessage(base))
    for (const variant of [
      { ...base, nonce: 'other-nonce' },
      { ...base, machineId: 'machine-02' },
      { ...base, slug: 'pc2' },
    ]) {
      expect(Buffer.from(deviceChallengeMessage(variant)).equals(original)).toBe(false)
    }
  })

  it('keeps field boundaries unambiguous when a field contains delimiters', () => {
    // 用分隔符连接的编码会把这两个身份折叠成同一条
    // 消息，使一台机器的签名能够认证另一台机器。
    const smuggled = Buffer.from(deviceChallengeMessage({
      nonce: 'nonce-value',
      machineId: 'machine-01\npc1',
      slug: 'pc1',
    }))
    expect(smuggled.equals(Buffer.from(deviceChallengeMessage(base)))).toBe(false)
  })
})
describe('membership contract', () => {
  const joined = {
    version: 1,
    hub: {
      relayUrl: 'ws://10.1.2.87:30809',
      slug: 'pc1',
      enrollToken: 'enroll-token-0123456789abcdef',
      browserAuthority: '10.1.2.87:30810',
      joinedAt: 1_800_000_000_000,
    },
  } as const

  it('round-trips a joined machine', () => {
    expect(parseMembership(serializeMembership(joined))).toEqual(joined)
  })

  it('treats a missing or empty file as not joined', () => {
    expect(parseMembership(undefined)).toBeUndefined()
    expect(parseMembership('   ')).toBeUndefined()
  })

  it('accepts a membership whose token was already spent', () => {
    const spent: Record<string, unknown> = { ...joined.hub }
    delete spent.enrollToken
    expect(parseMembership(serializeMembership({ version: 1, hub: spent } as never))?.hub?.enrollToken)
      .toBeUndefined()
  })

  it('rejects a relay URL that is not a WebSocket URL', () => {
    for (const relayUrl of ['http://10.1.2.87:30809', 'not-a-url', '']) {
      expect(() => parseMembership(serializeMembership({
        ...joined,
        hub: { ...joined.hub, relayUrl },
      } as never))).toThrow()
    }
  })

  // 格式错误的文件不能被静默读取为“从未加入”：否则会让
  // 这台机器脱离 hub，却不通知任何人。
  it('throws on malformed contents instead of resetting membership', () => {
    expect(() => parseMembership('{')).toThrow()
    expect(() => parseMembership('{"version":99}')).toThrow()
    expect(() => parseMembership(JSON.stringify({ ...joined, extra: true }))).toThrow()
  })
})