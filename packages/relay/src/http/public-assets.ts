import { Buffer } from 'node:buffer'
import type { ServerResponse } from 'node:http'
import { ICON_ICO_PATH, ICON_PNG_PATH, ICON_SVG_PATH } from '../admin/shared.js'
import { sendHttp } from './responses.js'
import { ICON_ICO, ICON_PNG, ICON_PNG_SIZE, ICON_SVG } from '../icons.js'

/** 浏览器无需凭据即可获取的唯一路径；由 relay 自己提供。 */
export const MANIFEST_PATH = '/manifest.webmanifest'

/**
 * 故意不可安装：PWA 已推迟（D10），且没有 service worker，因此浏览器不会提供安装选项。
 * manifest 的存在是为了避免浏览器把 HTML 登录页解析成 JSON；它还列出了 relay 已提供的图标。
 */
const RELAY_MANIFEST = `${JSON.stringify({
  id: '/',
  name: 'dsh-remote',
  short_name: 'dsh-remote',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  icons: [
    { src: ICON_SVG_PATH, sizes: 'any', type: 'image/svg+xml' },
    { src: ICON_PNG_PATH, sizes: `${ICON_PNG_SIZE}x${ICON_PNG_SIZE}`, type: 'image/png' },
  ],
}, undefined, 2)}\n`

/**
 * 固定的构建期图标字节在认证前直接响应，登录页因此可以在没有凭据时显示自己的图标。
 */
const ICON_ASSETS = new Map<string, { readonly body: Buffer; readonly type: string }>([
  [ICON_SVG_PATH, { body: Buffer.from(ICON_SVG, 'utf8'), type: 'image/svg+xml; charset=utf-8' }],
  [ICON_ICO_PATH, { body: ICON_ICO, type: 'image/x-icon' }],
  [ICON_PNG_PATH, { body: ICON_PNG, type: 'image/png' }],
])

/** 响应 relay 自己拥有的固定公开资源；返回 true 表示请求已结束。 */
export function servePublicAsset(
  pathname: string,
  method: string | undefined,
  res: ServerResponse,
): boolean {
  if (pathname === MANIFEST_PATH) {
    if (method !== 'GET' && method !== 'HEAD') {
      sendHttp(res, 405, 'method not allowed')
      return true
    }
    res.writeHead(200, {
      'cache-control': 'no-store',
      'content-type': 'application/manifest+json; charset=utf-8',
      'x-content-type-options': 'nosniff',
    })
    res.end(method === 'HEAD' ? undefined : RELAY_MANIFEST)
    return true
  }

  const icon = ICON_ASSETS.get(pathname)
  if (icon === undefined) return false
  if (method !== 'GET' && method !== 'HEAD') {
    sendHttp(res, 405, 'method not allowed')
    return true
  }
  res.writeHead(200, {
    'cache-control': 'public, max-age=86400',
    'content-type': icon.type,
    'content-length': icon.body.byteLength,
    'x-content-type-options': 'nosniff',
  })
  res.end(method === 'HEAD' ? undefined : icon.body)
  return true
}
