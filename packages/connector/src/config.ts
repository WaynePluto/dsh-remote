import { join } from 'node:path'
import { z } from 'zod'
import { dshWebTokenSchema, machineIdSchema, machineSlugSchema } from '@dsh-remote/protocol'
import { DEVICE_KEY_FILE_NAME } from './device-key.js'
import { defaultDshRemoteHome } from './membership.js'
import { CONNECTOR_VERSION } from './version.js'

/** A relay URL this connector cannot dial; the message says why. */
export class RelayUrlError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RelayUrlError'
  }
}

/**
 * Accept ws/wss (and the http/https spellings people paste from a browser) and
 * normalize to a bare WebSocket origin, because tunnel paths are appended later.
 *
 * @param value - a relay URL from the command line or from membership.json.
 * @returns The normalized `scheme://host[:port]` origin.
 * @throws RelayUrlError When the URL cannot address a relay.
 */
export function normalizeRelayUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new RelayUrlError(`relayUrl is not a valid URL: ${value}`)
  }
  const scheme = { 'ws:': 'ws:', 'wss:': 'wss:', 'http:': 'ws:', 'https:': 'wss:' }[url.protocol]
  if (scheme === undefined) {
    throw new RelayUrlError(`relayUrl scheme must be ws/wss (or http/https), got ${url.protocol}`)
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new RelayUrlError('relayUrl must not contain a path; tunnel paths are fixed by the protocol')
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new RelayUrlError('relayUrl must not contain credentials, a query, or a fragment')
  }
  url.protocol = scheme
  return `${url.protocol}//${url.host}`
}

const relayUrlSchema = z.string().min(1).transform((value, ctx) => {
  try {
    return normalizeRelayUrl(value)
  } catch (error) {
    ctx.addIssue({ code: 'custom', message: error instanceof Error ? error.message : String(error) })
    return z.NEVER
  }
})

const connectorConfigShape = z.strictObject({
  /**
   * Relay WebSocket origin, e.g. wss://relay.dsh.example.com.
   *
   * Optional on purpose: when it is absent the hub comes from
   * `<home>/membership.json` instead, and the connector idles until it appears.
   */
  relayUrl: relayUrlSchema.optional(),
  /** Stable device id; the Ed25519 device key is bound to it by the relay. */
  machineId: machineIdSchema,
  /**
   * One controlled machine = one subdomain. Optional: a machine that joins from
   * a hub's admin console learns its slug from `membership.json`, so only the
   * CLI-selected path has to supply one.
   */
  slug: machineSlugSchema.optional(),
  /** Per-user state directory holding `device.key` and `membership.json`. */
  home: z.string().min(1).default(() => defaultDshRemoteHome()),
  /** Where this machine's Ed25519 identity lives; created on first run. */
  deviceKeyPath: z.string().min(1).optional(),
  /**
   * Single-use relay enrollment token. Only needed until the relay knows this
   * device's public key; afterwards the signature alone authenticates.
   */
  enrollToken: z.string().min(16).optional(),
  /**
   * Browser-facing authority of the hub named by `--relay`, e.g. `10.1.2.87`.
   * Mode A forwards the browser's original Host untouched, so this machine's
   * dsh must trust it; the connector only records and reports it.
   */
  hubAuthority: z.string().min(1).max(255).optional(),
  /** Security invariant: dsh itself is never exposed beyond IPv4 loopback. */
  dshHost: z.literal('127.0.0.1').default('127.0.0.1'),
  dshPort: z.number().int().min(1).max(65_535).default(3080),
  /**
   * dsh's own browser login token, printed by `dsh web` as
   * `dsh web: http://127.0.0.1:<port>/?token=<token>`.
   *
   * Optional: a connector started beside a dsh nobody captured the line from
   * still tunnels traffic, but the browser then has to reach dsh's own login
   * exchange some other way. Whoever spawns dsh (the launcher) supplies it.
   */
  dshToken: dshWebTokenSchema.optional(),
  connectorVersion: z.string().min(1).max(64).default(CONNECTOR_VERSION),
})

export const connectorConfigSchema = connectorConfigShape.transform(value => ({
  ...value,
  // The device key lives in the same home as membership.json, so pointing
  // --home at a scratch directory keeps a whole identity together.
  deviceKeyPath: value.deviceKeyPath ?? join(value.home, DEVICE_KEY_FILE_NAME),
}))

export type ConnectorConfig = z.output<typeof connectorConfigSchema>
export type ConnectorConfigInput = z.input<typeof connectorConfigSchema>

/**
 * One hub this connector can dial, after precedence between `--relay` and
 * `membership.json` has been decided.
 */
export interface HubTarget {
  /** Normalized WebSocket origin. */
  readonly relayUrl: string
  /** The slug this machine claims on that hub. */
  readonly slug: string
  readonly enrollToken?: string | undefined
  /**
   * Browser-facing authority of the hub, e.g. `10.1.2.87:30810`. Mode A
   * forwards the browser's original Host untouched, so this machine's dsh must
   * trust it via `--trusted-host`. The connector only records it; spawning and
   * configuring dsh is the launcher's job.
   */
  readonly browserAuthority?: string | undefined
}

/** A config whose hub is known: what a single control session actually dials. */
export type SessionConfig = Omit<ConnectorConfig, 'relayUrl' | 'slug'> & {
  readonly relayUrl: string
  readonly slug: string
}

/**
 * @param config - the process-wide connector config.
 * @param hub - the hub this session dials.
 * @returns The config a control session sees, with the hub's identity applied.
 */
export function toSessionConfig(config: ConnectorConfig, hub: HubTarget): SessionConfig {
  return { ...config, relayUrl: hub.relayUrl, slug: hub.slug, enrollToken: hub.enrollToken }
}

export function resolveConnectorConfig(input: ConnectorConfigInput): ConnectorConfig {
  return connectorConfigSchema.parse(input)
}
