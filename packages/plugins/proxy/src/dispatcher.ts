/** 模型目录契约：此处说明 provider、协议、目录覆盖和用户条目保留。 */

import { Agent, EnvHttpProxyAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici'
import type { Dispatcher } from 'undici'
import { normalizeBypass, parseProxyUrl } from './settings.js'
import type { ProxySettings } from './shared.js'

/** 实现说明：此处记录相关接口、边界和生命周期约束。（涉及：`Symbol.for`、`WeakSet`） */
const OWNED = Symbol.for('dsh-remote.proxy.agent')

/** 实现说明：此处记录相关接口、边界和生命周期约束。 */
export function ownedProxy(dispatcher: unknown): string | undefined {
  if (typeof dispatcher !== 'object' || dispatcher === null) return undefined
  const marked = (dispatcher as Record<symbol, unknown>)[OWNED]
  return typeof marked === 'string' ? marked : undefined
}

/** 进程与运行时契约：此处说明生命周期、身份核验、轮询或终端边界。 */
function ambientDispatcher(): Dispatcher {
  const current = getGlobalDispatcher()
  return ownedProxy(current) === undefined ? current : new Agent()
}

/** 进程与运行时契约：此处说明生命周期、身份核验、轮询或终端边界。 */
export interface ProxyState {
  /** 实现说明：此处记录相关接口、边界和生命周期约束。 */
  via: string | null
  /** 实现说明：此处记录相关接口、边界和生命周期约束。 */
  bypass: string
}

/** 实现说明：此处记录相关接口、边界和生命周期约束。（涉及：`Agent`） */
export class ProxyDispatcher {
  private readonly ambient: Dispatcher
  private installed: EnvHttpProxyAgent | undefined
  private bypassInForce = ''

  constructor() {
    this.ambient = ambientDispatcher()
  }

  /** 进程与运行时契约：此处说明生命周期、身份核验、轮询或终端边界。 */
  current(): ProxyState {
    return { via: ownedProxy(getGlobalDispatcher()) ?? null, bypass: this.bypassInForce }
  }

  /** 进程与运行时契约：此处说明生命周期、身份核验、轮询或终端边界。 */
  apply(settings: ProxySettings): ProxyState {
    const url = settings.enabled ? parseProxyUrl(settings.url) : undefined
    const via = url === undefined ? null : url.toString()
    const bypass = normalizeBypass(settings.bypass)
    if (via === this.current().via && bypass === this.bypassInForce) {
      this.bypassInForce = bypass
      return this.current()
    }

    const previous = this.installed
    if (via === null) {
      this.installed = undefined
      // 实现说明：此处记录相关接口、边界和生命周期约束。
      // header。“关闭”是进程必须直连的声明，不是
      // 把控制权交还给最初对象的指令。
      setGlobalDispatcher(new Agent())
    } else {
      // 所有 option 都显式传入；环境变量为何
      // 不能通过省略字段渗入，见本模块说明。
      const agent = new EnvHttpProxyAgent({ httpProxy: via, httpsProxy: via, noProxy: bypass })
      // 安装前先标记，后续 incarnation 才能把该
      // 实现说明：此处记录相关接口、边界和生命周期约束。
      Object.defineProperty(agent, OWNED, { value: via, configurable: true })
      this.installed = agent
      setGlobalDispatcher(agent)
    }
    this.bypassInForce = bypass
    // 交换后才关闭，绝不提前：已在飞行中的请求会保留
    // 当前 socket 直到完成。
    if (previous !== undefined) void previous.close().catch(() => {})
    return this.current()
  }

  /** 进程与运行时契约：此处说明生命周期、身份核验、轮询或终端边界。 */
  async dispose(): Promise<void> {
    const installed = this.installed
    this.installed = undefined
    this.bypassInForce = ''
    setGlobalDispatcher(this.ambient)
    if (installed !== undefined) await installed.close()
  }
}
