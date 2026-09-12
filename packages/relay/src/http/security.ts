import type { IncomingMessage, OutgoingHttpHeaders } from 'node:http'
import { isIP } from 'node:net'
import { machineSlugSchema } from '@dsh-remote/protocol'
import type { RelayConfig } from '../config.js'

export type BrowserRequestCheck =
  | { ok: true; slug: string; authority: string }
  | { ok: false; status: 403 | 404; message: string }

function authorityOf(host: string): URL | undefined {
  try {
    return new URL(`http://${host}`)
  } catch {
    return undefined
  }
}

/** IP 字面量或 `localhost`：Host 决定如何到达端口路由的 hub。 */
function isAddressLiteralHostname(hostname: string): boolean {
  const unbracketed = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname
  return hostname === 'localhost' || isIP(unbracketed) !== 0
}

function subdomainSlug(hostname: string, config: RelayConfig): string | undefined {
  if (config.publicDomain === undefined) return undefined
  const suffix = `.${config.publicDomain}`
  if (!hostname.endsWith(suffix)) return undefined
  const candidate = hostname.slice(0, -suffix.length)
  return machineSlugSchema.safeParse(candidate).success ? candidate : undefined
}

/**
 * 校验浏览器的原始路由 header 并解析目标机器。
 *
 * D16 固定了解析顺序：子域名，然后请求到达的专用成员端口，最后是裸 IP/localhost Host 的
 * `directSlug`。成员 listener 因此优先于 `directSlug`，后者继续为 hub 自有机器在主端口上服务。
 * @param req 浏览器请求，header 保持不变。
 * @param config 已解析的 relay 配置。
 * @param memberSlug 此 listener 专用的机器；请求到达成员端口时提供。
 * @returns 已解析的 slug 和原始 authority，或应返回的状态码。
 */
export function checkBrowserRequest(
  req: IncomingMessage,
  config: RelayConfig,
  memberSlug?: string,
): BrowserRequestCheck {
  const host = req.headers.host
  if (host === undefined) return { ok: false, status: 404, message: 'not found' }
  const authority = authorityOf(host)
  if (authority === undefined) return { ok: false, status: 404, message: 'not found' }

  const hostname = authority.hostname.toLowerCase()
  const fromSubdomain = subdomainSlug(hostname, config)
  let slug: string | undefined
  if (memberSlug === undefined) {
    slug = fromSubdomain
    if (slug === undefined && config.directSlug !== undefined && isAddressLiteralHostname(hostname)) {
      slug = config.directSlug
    }
  } else if (fromSubdomain === undefined) {
    // 与 directSlug 遵循相同的 Host 规则：端口路由的 hub 通过 IP 或 localhost 到达，
    // 无法识别的名称不得路由到任何地方。
    if (isAddressLiteralHostname(hostname)) slug = memberSlug
  } else if (fromSubdomain === memberSlug) {
    slug = memberSlug
  }
  // 成员端口只服务一台机器，因此指向其他机器的子域名会被拒绝，
  // 而不会静默跨路由到此 listener。
  if (slug === undefined) return { ok: false, status: 404, message: 'not found' }

  if (req.headers['sec-fetch-site'] === 'cross-site') {
    return { ok: false, status: 403, message: 'forbidden' }
  }

  const origin = req.headers.origin
  if (origin !== undefined) {
    try {
      const parsed = new URL(origin)
      if (parsed.protocol !== `${config.publicScheme}:` || parsed.host.toLowerCase() !== authority.host.toLowerCase()) {
        return { ok: false, status: 403, message: 'forbidden' }
      }
    } catch {
      return { ok: false, status: 403, message: 'forbidden' }
    }
  }

  return { ok: true, slug, authority: authority.host }
}

/**
 * 要发送到上游的 header：浏览器自己的 header，保持不变（模式 A）。
 *
 * dsh 会看到浏览器实际使用的 authority，并通过自己的 `--trusted-host` 声明接受它，
 * 因此 relay 绝不重写 Host 或 Origin（铁律 7）。不存在模式 B：dsh 0.1.2 删除了以前唯一
 * 需要伪造 loopback Host 的 loopback 固定 privileged-method 列表，伪造 Host 只会关闭 dsh 的
 * DNS rebinding 防护。
 * @param req 浏览器请求。
 * @returns 入站 header 的副本。
 */
export function upstreamHeaders(req: IncomingMessage): OutgoingHttpHeaders {
  return { ...req.headers }
}
