import { hostname } from 'node:os'
import { Command, InvalidArgumentError } from 'commander'
import { createConnector, ConnectorFatalError, type Connector } from './connector.js'
import { DeviceKeyError } from './device-key.js'
import { MembershipFileError, defaultDshStationHome } from './membership.js'

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

/** 回退到根据主机名生成的稳定、符合 DNS label 形状的 id。 */
function defaultMachineId(slug: string | undefined): string {
  const host = hostname().toLowerCase().replaceAll(/[^a-z0-9-]+/gu, '-').replace(/^-+|-+$/gu, '')
  if (host === '') return slug ?? 'dsh-station-machine'
  return slug === undefined ? host : `${host}-${slug}`
}

const program = new Command()
  .name('dsh-station-connector')
  .description('dsh-station reverse-tunnel connector')
  .option('--relay <url>', 'relay WebSocket origin, e.g. wss://relay.dsh.example.com; overrides membership.json. Without it the connector idles until a hub admin console joins this machine')
  .option('--slug <slug>', 'this machine\'s slug when using --relay; a hub joined from an admin console supplies its own')
  .option('--home <path>', `dsh-station home holding device.key and membership.json (default: ${defaultDshStationHome()})`)
  .option('--machine-id <id>', 'stable device id (default: <hostname>-<slug>)')
  .option('--device-key <path>', 'Ed25519 device key file (default: <home>/device.key)')
  .option('--enroll-token <token>', 'one-time relay enrollment token, only needed until this device is registered (prefer DSH_STATION_ENROLL_TOKEN)')
  .option('--hub-authority <host>', 'browser-facing authority of the hub, e.g. 10.1.2.87; mode A forwards the browser Host untouched, so this machine\'s dsh must trust it')
  .option('--dsh-host <host>', 'local dsh bind host (must remain 127.0.0.1)', dshHost, '127.0.0.1')
  .option('--dsh-port <port>', 'local dsh port', port, 3080)
  .option('--dsh-token <token>', 'dsh web login token printed by dsh on start-up (prefer DSH_STATION_DSH_TOKEN)')

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

// dsh 每次启动都会生成新 token，因此环境变量是通常的
// 路径：启动 dsh 的进程从它的第一行输出中读出 token。
const dshToken = options.dshToken ?? process.env.DSH_STATION_DSH_TOKEN

const enrollToken = options.enrollToken ?? process.env.DSH_STATION_ENROLL_TOKEN
if (enrollToken !== undefined && enrollToken.length < 16) {
  program.error('--enroll-token (or DSH_STATION_ENROLL_TOKEN) must be at least 16 characters; copy it verbatim from the relay')
  throw new Error('unreachable')
}
// CLI token 只适用于通过 CLI 选择的 relay；从管理控制台加入的
// hub 会在 membership.json 中携带自己的 token。
if (options.enrollToken !== undefined && options.relay === undefined) {
  program.error('--enroll-token (or DSH_STATION_ENROLL_TOKEN) needs --relay; a hub joined from an admin console carries its own token in membership.json')
  throw new Error('unreachable')
}

// 通过 CLI 选择的 relay 没有可用于读取 slug 的 membership 文件。
if (options.relay !== undefined && options.slug === undefined) {
  program.error('--relay needs --slug; only a hub joined from an admin console supplies its own slug')
  throw new Error('unreachable')
}

// 规则与 token 相同：它描述 hub，而从管理控制台加入的
// hub 会在 membership.json 中记录自己的 authority。
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

