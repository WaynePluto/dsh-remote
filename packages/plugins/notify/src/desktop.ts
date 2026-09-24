// 桌面壳本机回环通道（127.0.0.1:30810，仅绑 loopback）。
// 壳驻留并监听时通知交给壳（点击可在壳内定位会话），壳不在时回落 Windows toast，
// Web/CLI 既有行为不变。只有连接已建立并通过令牌握手才算接管——未连接一律回落 toast。
// 令牌由桌面壳生成、经 launcher → dsh 的环境变量传来；没有令牌说明没有桌面壳，
// 插件根本不会发起连接。失败后 60 秒冷却避免每次事件都白连；半开连接写失败同样按不可用处理。
import { connect, type Socket } from 'node:net'

const DESKTOP_HOST = '127.0.0.1'
const DESKTOP_PORT = 30810
const RETRY_COOLDOWN_MS = 60_000

let socket: Socket | undefined
let connected = false
let connecting = false
let unavailableUntil = 0

export interface DesktopNotice {
  sessionId?: string | undefined
  title: string
  body: string
}

/** 尝试把通知转发给桌面壳；返回 false 表示壳不可用，调用方回落 toast。 */
export function forwardToDesktop(notice: DesktopNotice, environment: NodeJS.ProcessEnv = process.env): boolean {
  const token = environment.DSH_STATION_NOTIFY_TOKEN
  if (token === undefined || token === '') return false
  if (Date.now() < unavailableUntil) return false
  if (socket !== undefined && connected && socket.writable) {
    try {
      socket.write(JSON.stringify(notice) + '\n')
      return true
    } catch {
      // 半开连接写失败：按壳不可用处理，回落 toast 并冷却重试。
      socket?.destroy()
      socket = undefined
      connected = false
      unavailableUntil = Date.now() + RETRY_COOLDOWN_MS
      return false
    }
  }
  if (!connecting) {
    connecting = true
    const pending = connect({ host: DESKTOP_HOST, port: DESKTOP_PORT })
    pending.setTimeout(500, () => pending.destroy())
    pending.on('connect', () => {
      // 握手是事件的前提：令牌不对的连接会被桌面壳立刻断开。
      pending.write(JSON.stringify({ auth: token }) + '\n')
      connecting = false
      connected = true
      socket = pending
    })
    pending.on('close', () => {
      connected = false
      connecting = false
      if (socket === pending) socket = undefined
    })
    pending.on('error', () => {
      unavailableUntil = Date.now() + RETRY_COOLDOWN_MS
    })
  }
  return false
}
