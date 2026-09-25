/**
 * `dev:desktop` 附着前的开发栈检查。
 *
 * 桌面壳 attach 模式对 `/` 只发一次 302，relay 未监听时用户只能看到
 * WebView 的「拒绝连接」页且无法恢复。这里在拉起壳之前做一次 TCP 探测，
 * 未监听就以明确的中文指引快速失败。
 */

import { connect } from 'node:net'
import process from 'node:process'

function reachable(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = connect({ host, port })
    const finish = (ok) => {
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeoutMs, () => finish(false))
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}

const target = process.argv[2]
if (target === undefined) {
  console.error('用法：node scripts/check-dev-relay.mjs <relay-url>')
  process.exit(2)
}
let url
try {
  url = new URL(target)
} catch {
  console.error(`无效的 relay 地址：${target}`)
  process.exit(2)
}
if (url.hostname !== '127.0.0.1' || url.port === '') {
  console.error(`relay 地址必须是 127.0.0.1 带显式端口：${target}`)
  process.exit(2)
}

if (!(await reachable(url.hostname, Number(url.port), 1500))) {
  console.error(`\n[dsh-station] 开发栈未运行：${url.origin} 拒绝连接`)
  console.error('           dev:desktop 是附着模式，请先在另一个终端运行 pnpm dev，')
  console.error('           等它输出本机入口 http://127.0.0.1:31809/ 后再启动桌面壳。\n')
  process.exit(1)
}
