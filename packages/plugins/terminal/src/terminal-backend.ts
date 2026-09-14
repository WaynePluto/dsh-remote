/* oxlint-disable no-await-in-loop -- terminal 启动重试必须串行等待上一次失败和退避。 */
import type { Context } from '@deepseek-ai/cordis'
import TerminalSessionService from '@deepseek-ai/dsh-terminal'
import * as terminalBash from '@deepseek-ai/dsh-terminal-bash'
import type { Config } from './config.js'

/** 启动失败重试之间的间隔。 */
const STARTUP_RETRY_DELAY_MS = 1500

/** pwsh 启动时移除 PSReadLine，避免重绘破坏 terminal-bash 的就绪探测。 */
export const PWSH_READLINE_SETUP = 'Remove-Module PSReadLine -Force -ErrorAction SilentlyContinue'

/** 传给交互式 pwsh backend 的稳定启动参数。 */
export function pwshShellArgs(): string[] {
  return ['-NoLogo', '-NoProfile', '-NoExit', '-Command', PWSH_READLINE_SETUP]
}

/** 给每次 terminal_open 提供独立的启动超时与重试。 */
export function installStartupRetry(
  ctx: Context,
  config: Config,
  sleep: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
): () => void {
  const terminals = ctx.get('terminals')
  if (terminals === undefined) return () => {}
  const registry = terminals as unknown as {
    spawn: (owner: unknown, request: unknown, signal?: AbortSignal) => Promise<unknown>
  }
  const original = registry.spawn
  const invoke = original.bind(registry)
  const attempts = Math.max(1, config.startupAttempts)
  registry.spawn = async (owner, request, signal) => {
    let failure: unknown
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      signal?.throwIfAborted()
      const deadline = AbortSignal.timeout(config.startupTimeoutMs)
      const combined = signal === undefined ? deadline : AbortSignal.any([signal, deadline])
      try {
        return await invoke(owner, request, combined)
      } catch (error: unknown) {
        if (signal?.aborted === true) throw error
        failure = error
        if (attempt < attempts) await sleep(STARTUP_RETRY_DELAY_MS)
      }
    }
    throw failure
  }
  return () => { registry.spawn = original }
}

/** 解析 terminal-bash 使用的具体 shell dialect。 */
export function resolveDialect(
  configured: Config['shellDialect'],
  platform: string = process.platform,
): 'bash' | 'pwsh' {
  if (configured !== 'auto') return configured
  return platform === 'win32' ? 'pwsh' : 'bash'
}

/** 组合传给 terminal-bash 的 backend 配置，保留 bash 上游默认 argv。 */
export function backendConfig(
  config: Config,
  platform: string = process.platform,
): { shellDialect: 'bash' | 'pwsh', timeoutMs: number, shellArgs?: string[] } {
  const shellDialect = resolveDialect(config.shellDialect, platform)
  const explicit = config.shellArgs.length > 0
  const harden = !explicit && shellDialect === 'pwsh' && config.hardenPwshReadLine
  return {
    shellDialect,
    timeoutMs: config.timeoutMs,
    ...explicit ? { shellArgs: config.shellArgs } : harden ? { shellArgs: pwshShellArgs() } : {},
  }
}

/** 挂载 dsh PTY registry、shell backend 与启动补偿。 */
export function mountTerminalBackend(ctx: Context, config: Config): void {
  // oxlint-disable-next-line no-new -- 构造函数通过 ctx 注册 terminal service，实例本身不需要保留。
  new TerminalSessionService(ctx)
  ctx.plugin(terminalBash, backendConfig(config))
  ctx.inject(['terminals'], scope => {
    scope.effect(() => installStartupRetry(scope, config), 'terminal: startup retry')
  })
}
