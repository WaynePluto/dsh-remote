import { installProxyFromEnvironment, proxyRouteFor } from '@deepseek-ai/dsh-http-proxy'
import { assertServiceable, normalizeBypass, parseProxyUrl, resolveMode } from './settings.js'
import type { ProxyMode, ProxySettings } from './shared.js'

export interface ProxyState {
  mode: ProxyMode
  bypass: string
}

/** 官方安装器同时管理全局 dispatcher、web-fetch 策略和环境；只允许逆序卸载。 */
export class ProxyDispatcher {
  private pending: Promise<void> = Promise.resolve()
  private disposeActive: (() => Promise<void>) | undefined
  private state: ProxyState = { mode: 'environment', bypass: '' }
  private closed = false

  current(): ProxyState {
    return { ...this.state }
  }

  /** 测试请求报告实际目标的路由，而不是从设置推断所有目标都走同一出口。 */
  route(url: URL): string | null {
    const route = proxyRouteFor(url)
    return route.proxied ? route.proxy : null
  }

  apply(settings: ProxySettings): Promise<ProxyState> {
    if (this.closed) return Promise.reject(new Error('proxy: dispatcher is disposed'))
    try { assertServiceable(settings) } catch (error) { return Promise.reject(error) }
    const mode = resolveMode(settings)
    const bypass = normalizeBypass(settings.bypass)
    const via = mode === 'plugin' ? parseProxyUrl(settings.url)?.toString() : undefined
    const next: ProxyState = { mode, bypass }
    const job = this.pending.then(async () => {
      if (this.closed) return undefined
      if (this.state.mode === mode && (mode !== 'plugin' || this.state.bypass === bypass && this.activeUrl === via)) {
        this.state = next
        return undefined
      }
      // 先解除上一层，再装新层；否则官方 disposer 会恢复已关闭的旧 agent 和过期策略。
      const dispose = this.disposeActive
      this.disposeActive = undefined
      this.activeUrl = undefined
      this.state = { mode: 'environment', bypass: '' }
      if (dispose !== undefined) await dispose()
      if (this.closed) return undefined
      if (mode !== 'environment') {
        const values = mode === 'plugin'
          ? { HTTP_PROXY: via, HTTPS_PROXY: via, NO_PROXY: bypass }
          : {}
        this.disposeActive = await installProxyFromEnvironment({
          get: (name) => {
            const value = values[name as keyof typeof values]
            return value === undefined ? undefined : { value }
          },
        }, (message) => { throw new Error(`proxy: ${message}`) })
        this.activeUrl = via
      }
      this.state = next
      return undefined
    })
    // 单个失败不会卡住后续热更新；失败时下层官方环境策略已恢复。
    this.pending = job.catch(() => {})
    return job.then(() => this.current())
  }

  private activeUrl: string | undefined

  async dispose(): Promise<void> {
    this.closed = true
    await this.pending
    const dispose = this.disposeActive
    this.disposeActive = undefined
    this.activeUrl = undefined
    this.state = { mode: 'environment', bypass: '' }
    if (dispose !== undefined) await dispose()
  }
}
