import net from 'node:net'
import type { Duplex } from 'node:stream'
import type { Logger } from 'pino'
import { WebSocket, createWebSocketStream } from 'ws'
import {
  LOCAL_DSH_CONNECT_TIMEOUT_MS,
  STREAM_CONNECT_TIMEOUT_MS,
  TUNNEL_STREAM_PATH,
  type OpenStreamFrame,
} from '@dsh-station/protocol'

export interface WorkStreamDeps {
  /** 规范化后的 relay WebSocket origin。 */
  readonly relayUrl: string
  readonly dshHost: string
  readonly dshPort: number
  readonly logger: Logger
  /** 在控制信道报告本地 dsh 失败（LOCAL_DSH_UNAVAILABLE）。 */
  readonly reportLocalUnavailable: (message: string) => void
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function abortError(): Error {
  const error = new Error('work stream opening was cancelled')
  error.name = 'AbortError'
  return error
}

function connectLocalDsh(host: string, port: number, signal: AbortSignal): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError())
      return
    }

    const socket = net.connect({ host, port })
    socket.setNoDelay(true)
    let done = false
    const timer = setTimeout(() => {
      fail(new Error(`connect timed out after ${String(LOCAL_DSH_CONNECT_TIMEOUT_MS)}ms`))
    }, LOCAL_DSH_CONNECT_TIMEOUT_MS)
    timer.unref()

    const cleanup = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      socket.removeListener('connect', onConnect)
      socket.removeListener('error', onError)
    }
    const fail = (error: Error): void => {
      if (done) return
      done = true
      cleanup()
      socket.destroy()
      reject(error)
    }
    function onAbort(): void {
      fail(abortError())
    }
    function onConnect(): void {
      if (done) return
      done = true
      cleanup()
      resolve(socket)
    }
    function onError(error: Error): void {
      fail(error)
    }

    signal.addEventListener('abort', onAbort, { once: true })
    socket.once('connect', onConnect)
    socket.once('error', onError)
  })
}

/**
 * relay 可能在客户端看到 `open` 前推送首字节，而 ws 会丢弃
 * 没有 listener 的 `message` 事件，因此必须在
 * open handler 内创建 duplex，而不是在 `await` 之后创建。
 */
function dialDataStream(url: string, signal: AbortSignal): Promise<Duplex> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError())
      return
    }

    const ws = new WebSocket(url, { handshakeTimeout: STREAM_CONNECT_TIMEOUT_MS })
    let done = false
    const cleanup = (): void => {
      signal.removeEventListener('abort', onAbort)
      ws.removeListener('open', onOpen)
      ws.removeListener('error', onError)
    }
    const fail = (error: Error): void => {
      if (done) return
      done = true
      cleanup()
      // CONNECTING 期间调用 `terminate()` 会产生 error；保留 listener 观察它。
      ws.once('error', () => {})
      ws.terminate()
      reject(error)
    }
    function onAbort(): void {
      fail(abortError())
    }
    function onError(error: Error): void {
      fail(error)
    }
    function onOpen(): void {
      if (done) return
      done = true
      cleanup()
      resolve(createWebSocketStream(ws))
    }

    signal.addEventListener('abort', onAbort, { once: true })
    ws.once('open', onOpen)
    ws.once('error', onError)
  })
}

/** 逐字节桥接；connector 从不解析经过其中的内容。 */
function bridge(a: Duplex, b: Duplex, onDone: (error?: Error) => void): void {
  let done = false
  const finish = (error?: Error): void => {
    if (done) return
    done = true
    a.destroy()
    b.destroy()
    onDone(error)
  }
  a.on('error', finish)
  b.on('error', finish)
  a.on('close', () => finish())
  b.on('close', () => finish())
  a.pipe(b)
  b.pipe(a)
}

/**
 * 每个浏览器连接对应一个工作连接（frp/ngrok 模型，见
 * docs/03-architecture.md §4.3）：回拨数据 WebSocket，并将它拼接到
 * 本地 dsh 的新 TCP 连接。
 */
export class WorkStreamPool {
  readonly #deps: WorkStreamDeps
  readonly #active = new Set<() => void>()
  readonly #shutdown = new AbortController()
  #closed = false

  constructor(deps: WorkStreamDeps) {
    this.#deps = deps
  }

  get size(): number {
    return this.#active.size
  }

  async open(frame: OpenStreamFrame): Promise<void> {
    const { relayUrl, dshHost, dshPort, logger } = this.#deps
    if (this.#closed) return
    if (frame.expiresAt <= Date.now()) {
      logger.warn({ streamId: frame.streamId }, 'stream token already expired; dropping open-stream')
      return
    }

    const signal = this.#shutdown.signal
    const url = `${relayUrl}${TUNNEL_STREAM_PATH}?token=${encodeURIComponent(frame.streamToken)}`
    let tunnel: Duplex
    try {
      tunnel = await dialDataStream(url, signal)
    } catch (error) {
      if (!this.#closed) {
        logger.warn({ err: error, streamId: frame.streamId }, 'failed to dial the relay data channel')
      }
      return
    }

    // 先与 relay 配对，这样本地 dsh 失败时会立即拆掉等待中的
    // HTTP/WebSocket 请求，而不是让它等待 token TTL。
    let local: net.Socket
    try {
      local = await connectLocalDsh(dshHost, dshPort, signal)
    } catch (error) {
      tunnel.destroy()
      if (this.#closed) return
      const message = `local dsh at ${dshHost}:${String(dshPort)} is unreachable: ${errorMessage(error)}`
      logger.error({ err: error, streamId: frame.streamId }, message)
      this.#deps.reportLocalUnavailable(message)
      return
    }
    if (this.#closed) {
      tunnel.destroy()
      local.destroy()
      return
    }

    const close = (): void => {
      tunnel.destroy()
      local.destroy()
    }
    this.#active.add(close)
    logger.debug({ streamId: frame.streamId, active: this.#active.size }, 'work stream open')
    bridge(tunnel, local, (error) => {
      this.#active.delete(close)
      if (error !== undefined) {
        logger.debug({ err: error, streamId: frame.streamId }, 'work stream ended with an error')
      }
    })
  }

  closeAll(): void {
    this.#closed = true
    this.#shutdown.abort()
    for (const close of this.#active) close()
    this.#active.clear()
  }
}
