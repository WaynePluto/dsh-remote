import { setTimeout as delay } from 'node:timers/promises'
import pino, { type Logger } from 'pino'
import type { Membership, MembershipHub } from '@dsh-remote/protocol'
import { nextBackoffDelay } from './backoff.js'
import {
  normalizeRelayUrl,
  resolveConnectorConfig,
  toSessionConfig,
  type ConnectorConfig,
  type ConnectorConfigInput,
  type HubTarget,
} from './config.js'
import { loadOrCreateDeviceKey } from './device-key.js'
import { runControlSession, type SessionOutcome } from './control.js'
import {
  MembershipFileError,
  clearSpentEnrollToken,
  membershipFilePath,
  readMembershipFile,
  watchMembershipFile,
} from './membership.js'

/** Retrying cannot fix this (rejected or revoked device key, incompatible protocol version). */
export class ConnectorFatalError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConnectorFatalError'
  }
}

export interface Connector {
  readonly config: ConnectorConfig
  readonly logger: Logger
  /** This machine's Ed25519 public key, base64url; what the relay registers. */
  readonly devicePublicKey: string
  /** True while an authenticated control channel is up. */
  readonly online: boolean
  /** The hub currently being dialled, or undefined while idle (not joined). */
  readonly hub: HubTarget | undefined
  /**
   * Browser-facing authority of the hub, when membership recorded one.
   * Mode A forwards the browser's original Host, so dsh on this machine has to
   * trust this authority (`--trusted-host`). Acting on it is the launcher's job.
   */
  readonly browserAuthority: string | undefined
  /** Run until `stop()`, or reject with ConnectorFatalError. */
  run(): Promise<void>
  /** Resolves the first time the control channel authenticates. */
  ready(): Promise<void>
  stop(): Promise<void>
}

/** Identity that decides whether a running control channel still serves membership. */
function hubKey(hub: HubTarget | undefined): string | undefined {
  return hub === undefined ? undefined : `${hub.relayUrl}|${hub.slug}`
}

export function createConnector(
  input: ConnectorConfigInput,
  options: { logger?: Logger } = {},
): Connector {
  const config = resolveConnectorConfig(input)
  const logger = options.logger ?? pino({ level: process.env.LOG_LEVEL ?? 'info' })
  // Load eagerly: an unusable key file must fail at startup, not on every retry.
  const deviceKey = loadOrCreateDeviceKey({ path: config.deviceKeyPath, logger })
  const membershipPath = membershipFilePath(config.home)

  /**
   * Precedence: an explicit `--relay` WINS over membership.json, and the file is
   * then not consulted at all. That keeps the dev stack (and any scripted
   * deployment) working exactly as before, with no hidden file able to redirect
   * a connector whose target was spelled out on the command line.
   */
  const cliHub: HubTarget | undefined = config.relayUrl === undefined || config.slug === undefined
    ? undefined
    : {
        relayUrl: config.relayUrl,
        slug: config.slug,
        enrollToken: config.enrollToken,
        browserAuthority: config.hubAuthority,
      }

  const controller = new AbortController()
  let online = false
  let attempt = 0
  /** Hub key the device is already enrolled with; an enroll token is single-use. */
  let registeredWith: string | undefined
  /** Last membership this connector accepted; the file may already differ. */
  let membership: Membership | undefined
  /** Hub derived from membership, kept as the fallback for an unreadable file. */
  let lastHub: HubTarget | undefined
  /** Hub of the session in flight or in backoff; undefined only while idle. */
  let dialing: HubTarget | undefined
  let sessionAbort: AbortController | undefined
  /** Set when membership retargets the connector, so backoff does not apply. */
  let switching = false
  let idleLogged = false
  let browserAuthority: string | undefined
  let announcedAuthority: string | undefined
  let running: Promise<void> | undefined
  let wake: (() => void) | undefined

  let readySettled = false
  let resolveReady!: () => void
  let rejectReady!: (error: Error) => void
  const readyPromise = new Promise<void>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })
  // `ready()` is optional; keep a fatal pre-ready failure from becoming an
  // unhandled rejection for callers that only observe `run()`.
  void readyPromise.catch(() => undefined)

  const wakeUp = (): void => {
    const resume = wake
    wake = undefined
    resume?.()
  }
  controller.signal.addEventListener('abort', wakeUp)

  const toHub = (value: Membership | undefined): HubTarget | undefined => {
    const joined = value?.hub
    if (joined === undefined) return undefined
    let relayUrl: string
    try {
      relayUrl = normalizeRelayUrl(joined.relayUrl)
    } catch (error) {
      throw new MembershipFileError(
        `${membershipPath} records a relay URL this connector cannot dial: ${error instanceof Error ? error.message : String(error)}. `
        + 'Re-join this machine from the hub admin console.',
        { cause: error },
      )
    }
    return {
      relayUrl,
      slug: joined.slug,
      enrollToken: joined.enrollToken,
      browserAuthority: joined.browserAuthority,
    }
  }

  // Read eagerly for the same reason as the device key: a malformed membership
  // file — or a hub URL this connector cannot dial — must fail loudly at
  // startup instead of quietly looking like "not joined".
  if (cliHub === undefined) {
    membership = readMembershipFile(membershipPath)
    lastHub = toHub(membership)
  }

  const noteAuthority = (hub: HubTarget | undefined): void => {
    browserAuthority = hub?.browserAuthority
    if (browserAuthority === undefined || browserAuthority === announcedAuthority) return
    announcedAuthority = browserAuthority
    logger.info(
      { browserAuthority },
      'hub browser authority recorded; dsh on this machine must trust it (--trusted-host <authority>) because mode A forwards the browser Host untouched',
    )
  }

  /**
   * Re-read membership on every attempt. `fs.watch` can miss events on some
   * platforms and this costs one small file read per connection attempt, which
   * is far cheaper (and more correct) than a polling timer.
   */
  const currentHub = (): HubTarget | undefined => {
    if (cliHub !== undefined) {
      noteAuthority(cliHub)
      return cliHub
    }
    try {
      const next = readMembershipFile(membershipPath)
      const hub = toHub(next)
      membership = next
      lastHub = hub
    } catch (error) {
      // Keep the last known membership: staying on the hub with stale data beats
      // silently going offline because the file was momentarily unreadable.
      logger.error({ err: error }, 'membership file is unusable; keeping the last known membership')
    }
    noteAuthority(lastHub)
    return lastHub
  }

  /** Forget the spent single-use token so it does not stay on disk. */
  const clearEnrollToken = (joined: MembershipHub): void => {
    try {
      if (!clearSpentEnrollToken(membershipPath, joined)) return
      const { enrollToken: _spent, ...rest } = joined
      membership = { version: 1, hub: rest }
      lastHub = toHub(membership)
      logger.info({ path: membershipPath }, 'enrollment accepted; removed the spent token from the membership file')
    } catch (error) {
      logger.error(
        { err: error, path: membershipPath },
        'could not remove the spent enrollment token; delete it by hand so a single-use secret does not sit on disk',
      )
    }
  }

  const dial = async (hub: HubTarget): Promise<SessionOutcome> => {
    const session = new AbortController()
    const stopSession = (): void => session.abort()
    controller.signal.addEventListener('abort', stopSession, { once: true })
    sessionAbort = session
    if (controller.signal.aborted) session.abort()
    const key = hubKey(hub)
    try {
      return await runControlSession({
        config: toSessionConfig(config, hub),
        deviceKey,
        registered: registeredWith === key,
        logger,
        signal: session.signal,
        onReady: () => {
          attempt = 0
          online = true
          registeredWith = key
          const joined = membership?.hub
          if (cliHub === undefined && joined !== undefined && joined.enrollToken !== undefined) {
            clearEnrollToken(joined)
          }
          if (!readySettled) {
            readySettled = true
            resolveReady()
          }
        },
      })
    } finally {
      sessionAbort = undefined
      controller.signal.removeEventListener('abort', stopSession)
    }
  }

  const onMembershipChange = (next: Membership | undefined): void => {
    let hub: HubTarget | undefined
    try {
      hub = toHub(next)
    } catch (error) {
      logger.error({ err: error }, 'ignoring a membership change this connector cannot use')
      return
    }
    membership = next
    lastHub = hub
    noteAuthority(hub)
    // Only the dialled identity matters: rewriting the file with the same hub
    // (a cleared token, a refreshed timestamp) must never drop a live channel.
    if (dialing !== undefined && hubKey(dialing) !== hubKey(hub)) {
      switching = true
      logger.info(
        { from: hubKey(dialing), to: hubKey(hub) },
        hub === undefined
          ? 'membership was cleared; leaving the hub and going idle'
          : 'membership now points at another hub; moving the control channel',
      )
      sessionAbort?.abort()
    }
    wakeUp()
  }

  const loop = async (): Promise<void> => {
    const watcher = cliHub === undefined
      ? watchMembershipFile({
          path: membershipPath,
          initial: membership,
          onChange: onMembershipChange,
          onError: (error) => {
            logger.error({ err: error }, 'membership file changed into something unusable; keeping the last known membership')
          },
        })
      : undefined
    try {
      while (!controller.signal.aborted) {
        if (switching) {
          switching = false
          attempt = 0
        }
        // Arm the wake-up before reading, so a change during the read is not lost.
        const changed = new Promise<void>((resolve) => { wake = resolve })
        const hub = currentHub()
        if (hub === undefined) {
          dialing = undefined
          if (!idleLogged) {
            idleLogged = true
            logger.warn(
              { membershipPath },
              'not joined to a hub yet; idling until membership appears (join this machine from a hub admin console)',
            )
          }
          // No timer, no spinning: only a membership change or stop() resumes here.
          // eslint-disable-next-line no-await-in-loop -- the idle wait must pause the loop
          await changed
          continue
        }

        idleLogged = false
        dialing = hub
        // eslint-disable-next-line no-await-in-loop -- reconnects are sequential by design
        const outcome = await dial(hub)
        online = false
        if (controller.signal.aborted) break
        if (switching) continue
        if (outcome.fatal) {
          const error = new ConnectorFatalError(outcome.message)
          if (!readySettled) {
            readySettled = true
            rejectReady(error)
          }
          throw error
        }
        const delayMs = nextBackoffDelay(attempt)
        attempt += 1
        logger.warn(
          { reason: outcome.message, retryInMs: delayMs, attempt },
          'control channel is down; reconnecting after backoff',
        )
        // A membership change cuts the backoff short: the new hub should not wait.
        // eslint-disable-next-line no-await-in-loop -- backoff must pause the loop
        await Promise.race([
          delay(delayMs, undefined, { signal: controller.signal }).catch(() => undefined),
          changed,
        ])
      }
    } finally {
      dialing = undefined
      watcher?.close()
    }
    if (!readySettled) {
      readySettled = true
      rejectReady(new Error('connector stopped before the control channel authenticated'))
    }
    logger.info('connector stopped')
  }

  return {
    config,
    logger,
    devicePublicKey: deviceKey.publicKey,
    get online() {
      return online
    },
    get hub() {
      return dialing
    },
    get browserAuthority() {
      return browserAuthority
    },
    run() {
      running ??= loop()
      return running
    },
    ready() {
      return readyPromise
    },
    async stop() {
      controller.abort()
      if (running === undefined) return
      await running.catch(() => undefined)
    },
  }
}


