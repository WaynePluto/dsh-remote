import { hostname } from 'node:os'
import { Command, InvalidArgumentError } from 'commander'
import { createConnector, ConnectorFatalError, type Connector } from './connector.js'
import { DeviceKeyError } from './device-key.js'
import { MembershipFileError, defaultDshRemoteHome } from './membership.js'

function port(value: string): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new InvalidArgumentError('port must be an integer from 1 to 65535')
  }
  return parsed
}

function dshHost(value: string): '127.0.0.1' {
  if (value !== '127.0.0.1') {
    throw new InvalidArgumentError('dsh host must remain 127.0.0.1')
  }
  return value
}

/** Fall back to a stable, DNS-label-shaped id derived from the host name. */
function defaultMachineId(slug: string | undefined): string {
  const host = hostname().toLowerCase().replaceAll(/[^a-z0-9-]+/gu, '-').replace(/^-+|-+$/gu, '')
  if (host === '') return slug ?? 'dsh-remote-machine'
  return slug === undefined ? host : `${host}-${slug}`
}

const program = new Command()
  .name('dsh-remote-connector')
  .description('dsh-remote reverse-tunnel connector')
  .option('--relay <url>', 'relay WebSocket origin, e.g. wss://relay.dsh.example.com; overrides membership.json. Without it the connector idles until a hub admin console joins this machine')
  .option('--slug <slug>', 'this machine\'s slug when using --relay; a hub joined from an admin console supplies its own')
  .option('--home <path>', `dsh-remote home holding device.key and membership.json (default: ${defaultDshRemoteHome()})`)
  .option('--machine-id <id>', 'stable device id (default: <hostname>-<slug>)')
  .option('--device-key <path>', 'Ed25519 device key file (default: <home>/device.key)')
  .option('--enroll-token <token>', 'one-time relay enrollment token, only needed until this device is registered (prefer DSH_REMOTE_ENROLL_TOKEN)')
  .option('--hub-authority <host>', 'browser-facing authority of the hub, e.g. 10.1.2.87; mode A forwards the browser Host untouched, so this machine\'s dsh must trust it')
  .option('--dsh-host <host>', 'local dsh bind host (must remain 127.0.0.1)', dshHost, '127.0.0.1')
  .option('--dsh-port <port>', 'local dsh port', port, 3080)
  .option('--dsh-token <token>', 'dsh web login token printed by dsh on start-up (prefer DSH_REMOTE_DSH_TOKEN)')

program.parse()
const options = program.opts<{
  relay?: string
  slug?: string
  home?: string
  machineId?: string
  deviceKey?: string
  enrollToken?: string
  hubAuthority?: string
  dshHost: '127.0.0.1'
  dshPort: number
  dshToken?: string
}>()

// dsh mints a fresh token on every start, so the environment variable is the
// normal path: whoever spawned dsh read it off that process's first output line.
const dshToken = options.dshToken ?? process.env.DSH_REMOTE_DSH_TOKEN

const enrollToken = options.enrollToken ?? process.env.DSH_REMOTE_ENROLL_TOKEN
if (enrollToken !== undefined && enrollToken.length < 16) {
  program.error('--enroll-token (or DSH_REMOTE_ENROLL_TOKEN) must be at least 16 characters; copy it verbatim from the relay')
  throw new Error('unreachable')
}
// The CLI token only applies to a CLI-selected relay; a hub joined from an
// admin console carries its own token inside membership.json.
if (options.enrollToken !== undefined && options.relay === undefined) {
  program.error('--enroll-token (or DSH_REMOTE_ENROLL_TOKEN) needs --relay; a hub joined from an admin console carries its own token in membership.json')
  throw new Error('unreachable')
}

// A CLI-selected relay carries no membership file to learn the slug from.
if (options.relay !== undefined && options.slug === undefined) {
  program.error('--relay needs --slug; only a hub joined from an admin console supplies its own slug')
  throw new Error('unreachable')
}

// Same rule as the token: it describes the hub, and the hub joined from an
// admin console records its own authority in membership.json.
if (options.hubAuthority !== undefined && options.relay === undefined) {
  program.error('--hub-authority needs --relay; a hub joined from an admin console carries its own authority in membership.json')
  throw new Error('unreachable')
}

let connector: Connector
try {
  connector = createConnector({
    relayUrl: options.relay,
    slug: options.slug,
    home: options.home,
    machineId: options.machineId ?? defaultMachineId(options.slug),
    deviceKeyPath: options.deviceKey,
    enrollToken,
    ...options.hubAuthority === undefined ? {} : { hubAuthority: options.hubAuthority },
    dshHost: options.dshHost,
    dshPort: options.dshPort,
    ...dshToken === undefined || dshToken === '' ? {} : { dshToken },
  })
} catch (error) {
  if (!(error instanceof DeviceKeyError) && !(error instanceof MembershipFileError)) throw error
  program.error(error.message)
  throw new Error('unreachable', { cause: error })
}

let stopping = false
const shutdown = (): void => {
  if (stopping) return
  stopping = true
  void connector.stop()
}
process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)

try {
  await connector.run()
} catch (error) {
  if (error instanceof ConnectorFatalError) {
    connector.logger.error({ reason: error.message }, 'connector stopped and will not retry')
    process.exitCode = 1
  } else {
    throw error
  }
}

