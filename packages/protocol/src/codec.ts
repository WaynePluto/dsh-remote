import { Buffer } from 'node:buffer'
import { MAX_CONTROL_FRAME_BYTES, PROTOCOL_VERSION } from './constants.js'
import { controlFrameSchema, type ControlFrame } from './frames.js'

export type ProtocolDecodeErrorCode =
  | 'FRAME_TOO_LARGE'
  | 'INVALID_JSON'
  | 'INVALID_FRAME'
  | 'UNSUPPORTED_PROTOCOL'

/** Expected wire failure suitable for a clear log line and protocol error frame. */
export class ProtocolDecodeError extends Error {
  readonly code: ProtocolDecodeErrorCode
  readonly details?: string

  constructor(code: ProtocolDecodeErrorCode, message: string, details?: string) {
    super(message)
    this.name = 'ProtocolDecodeError'
    this.code = code
    if (details !== undefined) this.details = details
  }
}

function byteLength(input: string | Buffer | ArrayBuffer | ArrayBufferView): number {
  if (typeof input === 'string') return Buffer.byteLength(input)
  if (Buffer.isBuffer(input)) return input.byteLength
  if (ArrayBuffer.isView(input)) return input.byteLength
  return input.byteLength
}

function toUtf8(input: string | Buffer | ArrayBuffer | ArrayBufferView): string {
  if (typeof input === 'string') return input
  if (Buffer.isBuffer(input)) return input.toString('utf8')
  if (ArrayBuffer.isView(input)) {
    return Buffer.from(input.buffer, input.byteOffset, input.byteLength).toString('utf8')
  }
  return Buffer.from(input).toString('utf8')
}

function frameVersion(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  return (value as { version?: unknown }).version
}

/** Decode and validate one JSON control frame, separating version mismatch from malformed input. */
export function decodeControlFrame(
  input: string | Buffer | ArrayBuffer | ArrayBufferView,
): ControlFrame {
  const size = byteLength(input)
  if (size > MAX_CONTROL_FRAME_BYTES) {
    throw new ProtocolDecodeError(
      'FRAME_TOO_LARGE',
      `control frame is ${String(size)} bytes; maximum is ${String(MAX_CONTROL_FRAME_BYTES)}`,
    )
  }

  let value: unknown
  try {
    value = JSON.parse(toUtf8(input)) as unknown
  } catch (error) {
    throw new ProtocolDecodeError(
      'INVALID_JSON',
      'control frame is not valid JSON',
      error instanceof Error ? error.message : undefined,
    )
  }

  const receivedVersion = frameVersion(value)
  if (typeof receivedVersion === 'number' && receivedVersion !== PROTOCOL_VERSION) {
    throw new ProtocolDecodeError(
      'UNSUPPORTED_PROTOCOL',
      `unsupported protocol version ${String(receivedVersion)}; expected ${String(PROTOCOL_VERSION)}`,
    )
  }

  const parsed = controlFrameSchema.safeParse(value)
  if (!parsed.success) {
    throw new ProtocolDecodeError(
      'INVALID_FRAME',
      'control frame does not match the protocol schema',
      parsed.error.issues.map(issue => `${issue.path.join('.') || '<root>'}: ${issue.message}`).join('; '),
    )
  }
  return parsed.data
}

/** Validate and encode one locally-created frame. */
export function encodeControlFrame(frame: ControlFrame): string {
  return JSON.stringify(controlFrameSchema.parse(frame))
}
