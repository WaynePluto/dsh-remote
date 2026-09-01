import type { IncomingMessage } from 'node:http'
import { isIP } from 'node:net'

export function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined) return false
  const normalized = address.toLowerCase().split('%', 1)[0] ?? address.toLowerCase()
  if (normalized === '::1') return true
  const mapped = normalized.startsWith('::ffff:') ? normalized.slice('::ffff:'.length) : normalized
  return isIP(mapped) === 4 && mapped.startsWith('127.')
}

export function isLoopbackHost(host: string | undefined): boolean {
  if (host === undefined) return false
  let hostname: string
  try {
    hostname = new URL(`http://${host}`).hostname.toLowerCase()
  } catch {
    return false
  }
  const unbracketed = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname
  return unbracketed === 'localhost' || isLoopbackAddress(unbracketed)
}

/** Never trust X-Forwarded-For for this exemption. Both raw facts must be loopback. */
export function isLoopbackBrowserRequest(request: IncomingMessage): boolean {
  return isLoopbackAddress(request.socket.remoteAddress) && isLoopbackHost(request.headers.host)
}
