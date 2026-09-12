import type { Server } from 'node:http'
import type { Logger } from 'pino'
import { memberPortBaseFor, type RelayConfig } from '../config.js'
import type { BrowserPortRange, RelayStore } from '../store/store.js'
import type { DeviceRecord } from '../store/types.js'

interface MemberListener {
  readonly slug: string
  readonly port: number
  readonly server: Server
}


function listen(server: Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => reject(error)
    server.once('error', onError)
    server.listen(port, host, () => {
      server.off('error', onError)
      resolve()
    })
  })
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve())
    server.closeAllConnections()
  })
}

/**
 * 每台成员机器拥有一个额外 TCP listener（D16 路由键 2）。
 *
 * hub 自身的机器故意不在其中：它通过主端口的 `directSlug` 访问，给它第二个地址只会拆散书签。
 * 每个 listener 都由调用方 factory 构建，因此成员端口运行与主端口完全相同的请求和升级管线，
 * 区别仅在于它解析到的 slug。
 */
export class MemberPortListeners {
  readonly #store: RelayStore
  readonly #config: RelayConfig
  readonly #logger: Logger
  readonly #createServer: (slug: string) => Server
  readonly #listeners = new Map<string, MemberListener>()
  readonly #queues = new Map<string, Promise<unknown>>()
  readonly #range: BrowserPortRange | undefined

  constructor(options: {
    store: RelayStore
    config: RelayConfig
    logger: Logger
    /** 构建整个管线都固定到这台机器的 server。 */
    createServer: (slug: string) => Server
  }) {
    this.#store = options.store
    this.#config = options.config
    this.#logger = options.logger
    this.#createServer = options.createServer
    const basePort = memberPortBaseFor(options.config)
    this.#range = basePort === undefined || options.config.memberPortCount === 0
      ? undefined
      : { basePort, count: options.config.memberPortCount }
  }

  /** 机器当前的端口；没有开放 listener 时为 undefined。 */
  portOf(machineId: string): number | undefined {
    return this.#listeners.get(machineId)?.port
  }

  /**
   * 使开放的 listener 与存储的设备保持一致。
   *
   * 启动时调用一次，也可以安全地再次调用：它会打开缺少的 listener，关闭不再符合条件的 listener，
   * 因此 relay 停机期间被删除或吊销的设备不会带着活动端口重新出现。
   */
  async syncFromStore(): Promise<void> {
    if (this.#range === undefined) return
    const devices = this.#store.listDevices().filter(device => this.#qualifies(device))
    const expected = new Set(devices.map(device => device.machineId))
    await Promise.all([...this.#listeners.keys()]
      .filter(machineId => !expected.has(machineId))
      .map(machineId => this.release(machineId)))
    // 这里每机器队列都是空的，因此预留会按列表顺序发生，尽管实际绑定彼此重叠。
    await Promise.all(devices.map(async (device) => {
      try {
        await this.ensure(device.machineId)
      } catch (error) {
        this.#logger.error(
          { err: error, machineId: device.machineId, slug: device.slug },
          'failed to open the browser port for a member machine',
        )
      }
    }))
  }

  /**
   * 确保这台机器已分配端口并在其上拥有活动 listener。
   * @param machineId 要开放的机器。
   * @returns 它可访问的端口；不是成员时返回 undefined
   * （未知、已吊销、hub 自身机器或禁用端口路由）。
   * @throws BrowserPortRangeExhaustedError 配置范围已满时抛出。
   */
  async ensure(machineId: string): Promise<number | undefined> {
    if (this.#range === undefined) return undefined
    return this.#serialize(machineId, () => this.#ensure(machineId))
  }

  /** 关闭这台机器的 listener（如果有）；端口继续为重新注册保留。 */
  async release(machineId: string): Promise<void> {
    await this.#serialize(machineId, () => this.#release(machineId))
  }

  async closeAll(): Promise<void> {
    // 先排空：仍在完成的 bind 否则可能在 map 清空后注册自己的 listener，使进程继续存活。
    await Promise.all(this.#queues.values())
    this.#queues.clear()
    const listeners = [...this.#listeners.values()]
    this.#listeners.clear()
    await Promise.all(listeners.map(async listener => close(listener.server)))
  }

  /**
   * 在该机器已经排队的所有工作之后运行一项工作。
   *
   * 注册事件、吊销和启动同步可能同时指向同一台机器；没有队列时，其中两个可能尝试绑定同一端口，
   * 或者吊销可能关闭仍在由注册打开的 listener。map 以机器为键，因此规模与设备表一样小。
   */
  async #serialize<T>(machineId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.#queues.get(machineId) ?? Promise.resolve()
    const next = previous.then(task, task)
    this.#queues.set(machineId, next.catch(() => undefined))
    return next
  }

  async #ensure(machineId: string): Promise<number | undefined> {
    if (this.#range === undefined) return undefined
    const device = this.#store.getDeviceByMachineId(machineId)
    if (device === undefined || !this.#qualifies(device)) {
      await this.#release(machineId)
      return undefined
    }
    const existing = this.#listeners.get(machineId)
    if (existing !== undefined) {
      if (existing.slug === device.slug) return existing.port
      // 重新注册把这台机器移到了另一个 slug；开放的 listener 会继续转发到旧 slug。
      await this.#release(machineId)
    }

    const port = this.#store.allocateDeviceBrowserPort({ machineId, range: this.#range })
    const server = this.#createServer(device.slug)
    try {
      await listen(server, this.#config.host, port)
    } catch (error) {
      await close(server)
      throw error
    }
    this.#listeners.set(machineId, { slug: device.slug, port, server })
    this.#logger.info({ machineId, slug: device.slug, port }, 'member machine browser port open')
    return port
  }

  async #release(machineId: string): Promise<void> {
    const listener = this.#listeners.get(machineId)
    if (listener === undefined) return
    this.#listeners.delete(machineId)
    await close(listener.server)
    this.#logger.info(
      { machineId, slug: listener.slug, port: listener.port },
      'member machine browser port closed',
    )
  }

  #qualifies(device: DeviceRecord): boolean {
    return device.revokedAt === null && device.slug !== this.#config.directSlug
  }
}
