/**
 * Connector 为响应控制信道 challenge 而签名的规范字节。
 *
 * 两侧必须以完全相同的方式生成消息，因此它位于共享的
 * protocol 包中，而不是任一实现包中。
 */

/**
 * 域分离标签。它防止设备签名被重放为
 * 本项目未来可能使用同一密钥生成的其他签名。
 */
const DOMAIN = 'dsh-station/device-challenge/v2'

function lengthPrefixed(value: string): Uint8Array {
  const bytes = new TextEncoder().encode(value)
  const header = new Uint8Array(4)
  new DataView(header.buffer).setUint32(0, bytes.length, false)
  return concat([header, bytes])
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const output = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.length
  }
  return output
}

export interface DeviceChallengeInput {
  /** Relay 为本次握手签发的 nonce。 */
  readonly nonce: string
  readonly machineId: string
  readonly slug: string
}

/**
 * 构建某个 challenge 要签名的精确字节。
 *
 * 每个字段都带长度前缀而不是用分隔符连接：`machineId`
 * 接受任意文本，因此可以把分隔符偷偷放进字段，使
 * 两个不同身份生成完全相同的消息。
 * @returns 要签名或验证的消息字节。
 */
export function deviceChallengeMessage(input: DeviceChallengeInput): Uint8Array {
  return concat([
    lengthPrefixed(DOMAIN),
    lengthPrefixed(input.nonce),
    lengthPrefixed(input.machineId),
    lengthPrefixed(input.slug),
  ])
}
