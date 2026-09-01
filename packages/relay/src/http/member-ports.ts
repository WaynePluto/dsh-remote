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
 * Owns one extra TCP listener per member machine (D16 routing key 2).
 *
 * The hub's own machine is deliberately absent: it is reached on the main port
 * through `directSlug`, so giving it a second address would only split
 * bookmarks. Every listener is built by the caller's factory, so a member port
 * runs the exact same request and upgrade pipeline as the main port and differs
 * only in the slug it resolves to.
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
    /** Builds a server whose whole pipeline is pinned to this one machine. */
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

  /** The live port of a machine, or undefined when it has no open listener. */
  portOf(machineId: string): number | undefined {
    return this.#listeners.get(machineId)?.port
  }

  /**
   * Bring the open listeners in line with the stored devices.
   *
   * Called once at startup and safe to call again: it opens what is missing and
   * closes what no longer qualifies, so a device removed or revoked while the
   * relay was down does not come back with a live port.
   */
  async syncFromStore(): Promise<void> {
    if (this.#range === undefined) return
    const devices = this.#store.listDevices().filter(device => this.#qualifies(device))
    const expected = new Set(devices.map(device => device.machineId))
    await Promise.all([...this.#listeners.keys()]
      .filter(machineId => !expected.has(machineId))
      .map(machineId => this.release(machineId)))
    // The per-machine queues start empty here, so the reservations happen in
    // listing order even though the binds themselves overlap.
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
   * Make sure this machine has an allocated port and a live listener on it.
   * @param machineId The machine to expose.
   * @returns The port it is reachable on, or undefined when it is not a member
   * (unknown, revoked, the hub's own machine, or port routing disabled).
   * @throws BrowserPortRangeExhaustedError when the configured range is full.
   */
  async ensure(machineId: string): Promise<number | undefined> {
    if (this.#range === undefined) return undefined
    return this.#serialize(machineId, () => this.#ensure(machineId))
  }

  /** Close this machine's listener, if any; its port stays reserved for a re-enrollment. */
  async release(machineId: string): Promise<void> {
    await this.#serialize(machineId, () => this.#release(machineId))
  }

  async closeAll(): Promise<void> {
    // Drain first: a bind that is still completing would otherwise register its
    // listener after the map was cleared and keep the process alive.
    await Promise.all(this.#queues.values())
    this.#queues.clear()
    const listeners = [...this.#listeners.values()]
    this.#listeners.clear()
    await Promise.all(listeners.map(async listener => close(listener.server)))
  }

  /**
   * Run one machine's work after everything already queued for it.
   *
   * An enrollment event, a revoke and a startup sync can all name the same
   * machine at once; without a queue two of them could try to bind the same
   * port, or a revoke could close a listener that an enrollment is still
   * opening. The map is keyed by machine, so it stays as small as the device
   * table.
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
      // A re-enrollment moved this machine to another slug; the open listener
      // would keep forwarding to the previous one.
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
