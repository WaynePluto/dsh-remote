import { describe, expect, it } from 'vitest'
import type { MembershipHub } from '@dsh-remote/protocol'
import { displayWidth, renderBanner } from '../src/banner.js'

const HUB: MembershipHub = {
  relayUrl: 'ws://10.1.2.87:30809',
  slug: 'pc1',
  browserAuthority: '10.1.2.87:30810',
  joinedAt: 1_700_000_000_000,
}

const LOCAL = { dshPort: 3080, relayPort: 30_809, lanAddress: '10.1.2.87' } as const

/** 只有每一行确实等宽时，边框才有说服力。 */
function boxLines(banner: string): string[] {
  return banner.split('\n').filter(line => /[┌│└]/u.test(line))
}

describe('banner', () => {
  it('always shows the local dsh address and never suggests opening a browser', () => {
    const banner = renderBanner(LOCAL)
    expect(banner).toContain('http://127.0.0.1:3080')
    expect(banner).toContain('按 Ctrl+C 退出')
    expect(banner).not.toContain('正在打开浏览器')
  })

  it('shows both console addresses and which of them needs a login', () => {
    const lines = boxLines(renderBanner(LOCAL))
    const loopback = lines.find(line => line.includes('http://127.0.0.1:30809'))
    const lan = lines.find(line => line.includes('http://10.1.2.87:30809'))
    expect(loopback).toContain('免登录')
    expect(lan).toContain('需登录')
    expect(lan).not.toContain('免登录')
  })

  it('says why the LAN console is unusable instead of printing a wrong address', () => {
    expect(renderBanner({ dshPort: 3080, relayPort: 30_809 }))
      .toContain('没找到局域网 IPv4 地址')
    expect(renderBanner({ ...LOCAL, relayHost: '127.0.0.1' }))
      .toContain('控制台只监听 127.0.0.1')
  })

  it('shows the public entry with a login note in domain mode', () => {
    const banner = renderBanner({
      ...LOCAL,
      relayHost: '127.0.0.1',
      publicUrl: 'https://hub.dsh.example.com',
    })
    expect(banner).toContain('公网访问')
    expect(banner).toContain('https://hub.dsh.example.com')
    // 域名模式监听 loopback：局域网行明确说已关闭，而不是打印错误地址。
    expect(banner).toContain('控制台只监听 127.0.0.1')
  })

  it('never prints a public entry outside domain mode', () => {
    expect(renderBanner(LOCAL)).not.toContain('公网访问')
  })

  it('tells a machine with no remote entry how to get one', () => {
    const banner = renderBanner(LOCAL)
    expect(banner).toContain('没有远程入口')
    expect(banner).toContain('「远程入口」页')
    expect(banner).not.toContain('远程访问')
  })

  it('shows how to reach this machine through its remote entry', () => {
    const banner = renderBanner({ ...LOCAL, hub: HUB })
    expect(banner).toContain('远程访问')
    expect(banner).toContain('http://10.1.2.87:30810')
    expect(banner).toContain('pc1')
    expect(renderBanner({
      ...LOCAL,
      hub: { ...HUB, relayUrl: 'wss://hub.example.com', browserAuthority: 'pc1.example.com' },
    })).toContain('https://pc1.example.com')
  })

  it('says why remote access is unusable when the hub authority is missing', () => {
    const banner = renderBanner({ ...LOCAL, hub: { ...HUB, browserAuthority: undefined } })
    expect(banner).toContain('--hub-authority')
    expect(banner).not.toContain('https://')
  })

  it.each([
    ['unjoined', undefined],
    ['joined', HUB],
    ['joined without an authority', { ...HUB, browserAuthority: undefined }],
  ])('draws a box that lines up when %s', (_case, hub) => {
    const lines = boxLines(renderBanner({ ...LOCAL, hub }))
    expect(lines.length).toBeGreaterThanOrEqual(3)
    const widths = new Set(lines.map(line => displayWidth(line)))
    expect(widths.size).toBe(1)
  })

  it('counts CJK characters as two columns', () => {
    expect(displayWidth('本机访问')).toBe(8)
    expect(displayWidth('http://127.0.0.1')).toBe(16)
  })
})

describe('banner before the console has an administrator', () => {
  const SETUP = { ...LOCAL, adminReady: false } as const

  it('sends the user to the loopback console to finish setup', () => {
    const banner = renderBanner(SETUP)
    expect(banner).toContain('还没有管理员账号')
    expect(banner).toContain('http://127.0.0.1:30809')
    expect(banner).toContain('验证器')
    expect(banner).toContain('二维码')
    expect(banner).toContain('按 Ctrl+C 退出')
  })

  it('says the wizard only answers on this machine', () => {
    expect(renderBanner(SETUP)).toContain('只能在本机做')
  })

  it('never opens or claims to open a browser', () => {
    expect(renderBanner(SETUP)).not.toContain('正在打开浏览器')
  })

  it('hides addresses that cannot be logged into yet', () => {
    const banner = renderBanner({ ...SETUP, hub: HUB })
    expect(banner).not.toContain('http://10.1.2.87:30809')
    expect(banner).not.toContain('http://10.1.2.87:30810')
    expect(banner).not.toContain('免登录')
  })

  it('draws a box that lines up around the setup address', () => {
    const lines = boxLines(renderBanner(SETUP))
    expect(lines.some(line => line.includes('http://127.0.0.1:30809'))).toBe(true)
    expect(new Set(lines.map(line => displayWidth(line))).size).toBe(1)
  })

  it('goes back to the address block once the administrator exists', () => {
    const banner = renderBanner({ ...LOCAL, adminReady: true, hub: HUB })
    expect(banner).not.toContain('还没有管理员账号')
    expect(banner).toContain('免登录')
    expect(banner).toContain('http://10.1.2.87:30810')
  })
})
