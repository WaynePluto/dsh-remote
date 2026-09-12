import http, { type IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import type { Logger } from 'pino'
import { TunnelError, type MachineRegistry } from '../tunnel/registry.js'
import { upstreamHeaders } from './security.js'

function writeResponseHead(
  socket: Duplex,
  statusCode: number,
  statusMessage: string | undefined,
  rawHeaders: readonly string[],
  setCookieHeaders: readonly string[] = [],
): void {
  const lines = [`HTTP/1.1 ${String(statusCode)} ${statusMessage ?? ''}`.trimEnd()]
  for (let index = 0; index < rawHeaders.length; index += 2) {
    lines.push(`${rawHeaders[index]}: ${rawHeaders[index + 1]}`)
  }
  for (const cookie of setCookieHeaders) lines.push(`Set-Cookie: ${cookie}`)
  socket.write(`${lines.join('\r\n')}\r\n\r\n`)
}

function rejectUpgrade(socket: Duplex, status: number, message: string): void {
  const body = `${message}\n`
  socket.end(
    `HTTP/1.1 ${String(status)} ${status === 502 ? 'Bad Gateway' : 'Forbidden'}\r\n`
    + 'Content-Type: text/plain; charset=utf-8\r\n'
    + `Content-Length: ${String(Buffer.byteLength(body))}\r\n`
    + 'Connection: close\r\n\r\n'
    + body,
  )
}

export async function proxyWebSocketUpgrade(options: {
  req: IncomingMessage
  browserSocket: Duplex
  browserHead: Buffer
  slug: string
  registry: MachineRegistry
  logger: Logger
  setCookieHeaders?: readonly string[]
}): Promise<void> {
  const { req, browserSocket, browserHead, slug, registry, logger } = options
  const setCookieHeaders = options.setCookieHeaders ?? []
  browserSocket.pause()

  let tunnel: Duplex
  try {
    tunnel = await registry.openStream(slug)
  } catch (error) {
    const message = error instanceof TunnelError ? error.message : 'tunnel unavailable'
    logger.warn({ err: error, slug }, 'failed to open WebSocket tunnel stream')
    rejectUpgrade(browserSocket, 502, message)
    return
  }

  if (browserSocket.destroyed) {
    tunnel.destroy()
    return
  }

  const headers = upstreamHeaders(req)
  headers.connection = 'Upgrade'
  headers.upgrade = req.headers.upgrade ?? 'websocket'

  const upstream = http.request({
    method: 'GET',
    path: req.url,
    headers,
    createConnection: () => tunnel,
  })

  let settled = false
  upstream.once('upgrade', (response, upstreamSocket, upstreamHead) => {
    settled = true
    writeResponseHead(
      browserSocket,
      response.statusCode ?? 101,
      response.statusMessage,
      response.rawHeaders,
      setCookieHeaders,
    )
    if (upstreamHead.byteLength > 0) browserSocket.write(upstreamHead)
    if (browserHead.byteLength > 0) upstreamSocket.write(browserHead)
    browserSocket.resume()
    browserSocket.pipe(upstreamSocket).pipe(browserSocket)
    upstreamSocket.once('error', error => browserSocket.destroy(error))
    browserSocket.once('error', error => upstreamSocket.destroy(error))
  })

  // fence 或升级路径拒绝时，dsh 会返回普通的 403/426 响应。
  upstream.once('response', (response) => {
    settled = true
    writeResponseHead(
      browserSocket,
      response.statusCode ?? 502,
      response.statusMessage,
      response.rawHeaders,
      setCookieHeaders,
    )
    browserSocket.resume()
    response.pipe(browserSocket)
    response.once('end', () => tunnel.destroy())
  })

  upstream.once('error', (error) => {
    logger.warn({ err: error, slug, path: req.url }, 'upstream WebSocket upgrade failed')
    // ClientRequest 已经报告并记录此 socket 失败。直接销毁，而不要在可能没有 listener 的隧道上
    // 再次发出同一错误。
    tunnel.destroy()
    if (!settled && !browserSocket.destroyed) rejectUpgrade(browserSocket, 502, 'upstream upgrade failed')
  })
  browserSocket.once('error', error => upstream.destroy(error))
  browserSocket.once('close', () => {
    if (!settled) upstream.destroy(new Error('browser socket closed before upgrade'))
  })
  upstream.end()
}
