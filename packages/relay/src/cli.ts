import { isIP } from 'node:net'
import process from 'node:process'
import { Command, InvalidArgumentError } from 'commander'
import pino, { type Logger } from 'pino'
import {
  AdminAlreadyInitializedError,
  AdminAmbiguousError,
  AdminNotFoundError,
  DEFAULT_ADMIN_USERNAME,
  PASSWORD_MIN_CHARACTERS,
  PASSWORD_REQUIRED_CLASSES,
  PasswordPolicyError,
  UsernamePolicyError,
  changeAdminPassword,
  createAuthenticationService,
  decodeJwtSecret,
  initializeAdmin,
  resetAdminTotp,
  resolveAdminUsername,
  validateNewPassword,
} from './auth/index.js'
import { DEFAULT_MEMBER_PORT_COUNT } from './config.js'
import { defaultDshStationHome } from './membership/index.js'
import { createRelayServer } from './server.js'
import { openRelayStore } from './store/index.js'

function port(value: string): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) {
    throw new InvalidArgumentError('port must be an integer from 0 to 65535')
  }
  return parsed
}

const MAX_MEMBER_PORT_COUNT = 1_024

function memberPortCount(value: string): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > MAX_MEMBER_PORT_COUNT) {
    throw new InvalidArgumentError(
      `member port count must be an integer from 0 to ${String(MAX_MEMBER_PORT_COUNT)}`,
    )
  }
  return parsed
}

function scheme(value: string): 'http' | 'https' {
  if (value === 'http' || value === 'https') return value
  throw new InvalidArgumentError('scheme must be http or https')
}

function bindHost(value: string): string {
  if (isIP(value) === 0) throw new InvalidArgumentError('host must be an IPv4 or IPv6 address')
  return value
}

/**
 * 单次恢复命令使用的审计日志出口。
 *
 * 它写入 stderr，避免机器可读的审计行与操作员正在阅读的
 * 面向人类输出交错。
 */
function cliAuditLogger(): Logger {
  return pino({ level: process.env.LOG_LEVEL ?? 'info' }, pino.destination(2))
}

async function hiddenPrompt(label: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY || process.stdin.setRawMode === undefined) {
    throw new Error('interactive password input needs a TTY; use DSH_STATION_ADMIN_PASSWORD for automation')
  }
  process.stdout.write(label)
  process.stdin.setEncoding('utf8')
  process.stdin.setRawMode(true)
  process.stdin.resume()

  return new Promise<string>((resolve, reject) => {
    let value = ''
    const finish = (error?: Error): void => {
      process.stdin.off('data', onData)
      process.stdin.setRawMode(false)
      process.stdin.pause()
      process.stdout.write('\n')
      if (error === undefined) resolve(value)
      else reject(error)
    }
    function onData(chunk: string): void {
      for (const character of chunk) {
        if (character === '\r' || character === '\n') {
          finish()
          return
        }
        if (character === '\u0003') {
          finish(new Error('password input cancelled'))
          return
        }
        if (character === '\u007f' || character === '\b') {
          value = [...value].slice(0, -1).join('')
          continue
        }
        if (character >= ' ') value += character
      }
    }
    process.stdin.on('data', onData)
  })
}

/** 预期的操作员错误：作为消息报告，绝不输出堆栈跟踪。 */
class CliUserError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CliUserError'
  }
}

const PASSWORD_ATTEMPTS = 3

/** 将已知操作员错误转换成一行简洁消息，而不是堆栈。 */
function reportExpectedError(error: unknown): void {
  if (error instanceof AdminAlreadyInitializedError) program.error(error.message)
  if (error instanceof AdminNotFoundError) program.error(error.message)
  if (error instanceof AdminAmbiguousError) program.error(error.message)
  if (error instanceof UsernamePolicyError) program.error(`账号名不符合要求：${error.message}`)
  if (error instanceof CliUserError) program.error(error.message)
  if (error instanceof PasswordPolicyError) program.error(`密码不符合要求：${error.message}`)
}

async function newAdminPassword(): Promise<string> {
  const fromEnvironment = process.env.DSH_STATION_ADMIN_PASSWORD
  if (fromEnvironment !== undefined) {
    try {
      validateNewPassword(fromEnvironment)
    } catch (error) {
      if (error instanceof PasswordPolicyError) {
        throw new CliUserError(`DSH_STATION_ADMIN_PASSWORD 不符合要求：${error.message}`)
      }
      throw error
    }
    return fromEnvironment
  }

  console.log(`管理员密码至少 ${String(PASSWORD_MIN_CHARACTERS)} 个字符，且要用上大写字母、小写字母、数字、符号里的至少 ${String(PASSWORD_REQUIRED_CLASSES)} 类，用于保护远程访问这台机器的入口。`)
  for (let attempt = 1; attempt <= PASSWORD_ATTEMPTS; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop -- 交互式提示本来就必须顺序执行
    const first = await hiddenPrompt('管理员密码: ')
    try {
      validateNewPassword(first)
    } catch (error) {
      if (!(error instanceof PasswordPolicyError)) throw error
      console.log(`  密码不符合要求：${error.message}`)
      continue
    }
    // eslint-disable-next-line no-await-in-loop -- 确认输入必须跟在第一次输入之后
    const second = await hiddenPrompt('再次输入密码: ')
    if (first === second) return first
    console.log('  两次输入的密码不一致。')
  }
  throw new CliUserError(`连续 ${String(PASSWORD_ATTEMPTS)} 次未能设置密码，已取消初始化。`)
}

interface ServeOptions {
  domain?: string
  directSlug?: string
  home?: string
  host: string
  port: number
  memberPortBase?: number
  memberPortCount: number
  scheme: 'http' | 'https'
  lanHttp: boolean
  data: string
}

async function serveRelay(options: ServeOptions, command: Command): Promise<void> {
  if (options.domain === undefined && options.directSlug === undefined) {
    command.error('one of --domain or --direct-slug is required')
  }
  const browserAuth = options.lanHttp
    ? { cookieMode: 'lan-http' as const }
    : options.domain === undefined
      ? undefined
      : { cookieMode: 'domain-https' as const }
  // connector 根据已注册设备进行认证，因此隧道即使在未配置浏览器认证时
  // 也需要 store。
  const store = openRelayStore({ path: options.data })
  // relay 自身日志和审计行共用一个出口，使发布的日志
  // 文件同时包含流量上下文和安全事件。
  const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' })
  let relay: ReturnType<typeof createRelayServer> | undefined
  try {
    let authentication
    if (browserAuth !== undefined) {
      const encodedSecret = process.env.DSH_STATION_JWT_SECRET
      if (encodedSecret === undefined) {
        command.error('browser authentication requires DSH_STATION_JWT_SECRET (32+ random base64url bytes)')
      }
      // 尚无管理员是正常的首次运行状态，不是错误：relay
      // 会提供 loopback 设置向导，直到有人创建账号。
      authentication = await createAuthenticationService({
        store,
        jwtSecret: decodeJwtSecret(encodedSecret),
        logger,
      })
    }

    relay = createRelayServer({
      host: options.host,
      port: options.port,
      ...options.domain === undefined ? {} : { publicDomain: options.domain },
      ...options.directSlug === undefined ? {} : { directSlug: options.directSlug },
      ...options.home === undefined ? {} : { home: options.home },
      ...options.memberPortBase === undefined ? {} : { memberPortBase: options.memberPortBase },
      memberPortCount: options.memberPortCount,
      publicScheme: options.scheme,
      ...browserAuth === undefined ? {} : { browserAuth },
    }, {
      store,
      logger,
      ...authentication === undefined ? {} : { authentication },
    })
    await relay.listen()
  } catch (error) {
    store.close()
    throw error
  }

  let closing = false
  const shutdown = async (): Promise<void> => {
    if (closing) return
    closing = true
    try {
      await relay?.close()
    } finally {
      store.close()
    }
  }
  process.once('SIGINT', () => void shutdown())
  process.once('SIGTERM', () => void shutdown())
}

const program = new Command()
  .name('dsh-station-relay')
  .description('authenticated dsh-station reverse-tunnel relay')

program.command('serve', { isDefault: true })
  .description('run the relay')
  .option('--domain <domain>', 'multi-machine public domain, e.g. dsh.example.com')
  .option('--direct-slug <slug>', 'route IP/localhost browser traffic to one machine')
  .option('--home <path>', `this machine's dsh-station state directory (default: ${defaultDshStationHome()})`)
  .option('--host <address>', 'listen address', bindHost, '127.0.0.1')
  .option('--port <port>', 'listen port', port, 30_809)
  .option('--member-port-base <port>', 'first per-machine browser port (default: main port + 1)', port)
  .option('--member-port-count <count>', 'how many per-machine browser ports to reserve', memberPortCount, DEFAULT_MEMBER_PORT_COUNT)
  .option('--scheme <scheme>', 'browser-facing scheme', scheme, 'https')
  .option('--lan-http', 'explicit insecure LAN development mode with authentication', false)
  .option('--data <path>', 'relay SQLite database', './data/relay.db')
  .action((options: ServeOptions, command: Command) => serveRelay(options, command))

program.command('init')
  .description('create the sole v1 administrator and TOTP enrollment')
  .option('--data <path>', 'relay SQLite database', './data/relay.db')
  .option('--username <name>', 'administrator username', DEFAULT_ADMIN_USERNAME)
  .action(async (options: { data: string; username: string }) => {
    const store = openRelayStore({ path: options.data })
    try {
      const result = await initializeAdmin({
        store,
        username: options.username,
        password: await newAdminPassword(),
        logger: cliAuditLogger(),
      })
      console.log('管理员已创建。请在验证器中添加以下 TOTP URI：')
      console.log(result.enrollment.uri)
      console.log('首次登录需输入验证器生成的 6 位动态码。')
    } catch (error) {
      reportExpectedError(error)
      throw error
    } finally {
      store.close()
    }
  })

program.command('passwd')
  .description('set a new administrator password and revoke every session')
  .option('--data <path>', 'relay SQLite database', './data/relay.db')
  .option('--username <name>', 'administrator username (default: the only account in the database)')
  .action(async (options: { data: string; username?: string }) => {
    const store = openRelayStore({ path: options.data })
    try {
      const result = await changeAdminPassword({
        store,
        username: resolveAdminUsername(store, options.username),
        password: await newAdminPassword(),
        logger: cliAuditLogger(),
      })
      console.log(`密码已更新，同时吊销了 ${String(result.revokedSessions)} 个登录会话。`)
      console.log('所有浏览器都需要重新登录；TOTP 验证器保持不变。')
    } catch (error) {
      reportExpectedError(error)
      throw error
    } finally {
      store.close()
    }
  })

const totp = program.command('totp')
  .description('manage the administrator authenticator binding')

totp.command('reset')
  .description('issue a new TOTP secret after a lost authenticator')
  .option('--data <path>', 'relay SQLite database', './data/relay.db')
  .option('--username <name>', 'administrator username (default: the only account in the database)')
  .action((options: { data: string; username?: string }) => {
    const store = openRelayStore({ path: options.data })
    try {
      const result = resetAdminTotp({
        store,
        username: resolveAdminUsername(store, options.username),
        logger: cliAuditLogger(),
      })
      console.log('已生成新的 TOTP。请先在验证器中删除旧条目，再添加：')
      console.log(result.enrollment.uri)
      console.log(`旧验证码立即失效，同时吊销了 ${String(result.revokedSessions)} 个登录会话。`)
      console.log('下次登录输入新验证器的动态码即完成绑定；密码保持不变。')
    } catch (error) {
      reportExpectedError(error)
      throw error
    } finally {
      store.close()
    }
  })

await program.parseAsync()
