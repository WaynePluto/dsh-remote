import { Buffer } from 'node:buffer'
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { LOGIN_PATH } from '../admin/auth-app.js'

const STATUS_REASON = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  503: 'Service Unavailable',
} as const

/** 发送 relay 自己生成的纯文本响应。 */
export function sendHttp(
  res: ServerResponse,
  status: number,
  message: string,
  headers: OutgoingHttpHeaders = {},
): void {
  const body = `${message}\n`
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    connection: 'close',
    ...headers,
  })
  res.end(body)
}

/** 把需要登录的浏览器导航送到认证页，并保留原始 URI。 */
export function redirectToLogin(req: IncomingMessage, res: ServerResponse): void {
  const returnTo = req.url?.startsWith('/') ? req.url : '/'
  res.writeHead(302, {
    location: `${LOGIN_PATH}?returnTo=${encodeURIComponent(returnTo)}`,
    'cache-control': 'no-store',
    'content-length': 0,
  })
  res.end()
}

/** 在 WebSocket 握手尚未升级时写回最小 HTTP 错误响应。 */
export function rejectSocket(
  socket: Duplex,
  status: keyof typeof STATUS_REASON,
  message: string,
): void {
  const body = `${message}\n`
  socket.end(
    `HTTP/1.1 ${String(status)} ${STATUS_REASON[status]}\r\n`
    + 'Content-Type: text/plain; charset=utf-8\r\n'
    + `Content-Length: ${String(Buffer.byteLength(body))}\r\n`
    + 'Connection: close\r\n\r\n'
    + body,
  )
}
