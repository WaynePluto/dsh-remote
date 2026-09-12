import zs from '@deepseek-ai/schemastery'

/** terminal backend 与 model tool 的挂载配置。 */
export interface Config {
  /** 是否挂载 dsh PTY registry 和 shell backend；关闭时 panel 没有内容。 */
  mountBackend: boolean
  /** 是否暴露六个上游 `terminal_*` model tools；关闭后无法创建 terminal。 */
  mountTools: boolean
  /** interactive shell dialect；`auto` 按平台选择。 */
  shellDialect: 'auto' | 'bash' | 'pwsh'
  /** 是否关闭 pwsh PSReadLine prediction/history 写入，避免 backend 首次运行后不可用。 */
  hardenPwshReadLine: boolean
  /** 传给 interactive shell 的完整 argv；非空时原样交给 `terminal-bash`。 */
  shellArgs: string[]
  /** 传给 `terminal-bash` 的单次 send wait 上限。 */
  timeoutMs: number
  /** 每次打开 session 的独立启动 timeout。 */
  startupTimeoutMs: number
  /** 打开 session 失败前允许的尝试次数。 */
  startupAttempts: number
  /** 人类输入等待正在进行的 model send 的时间；避免 `ctx.terminals` 第二个 send 直接 throw。 */
  sendWaitMs: number
}

/** Config 的 runtime schema。 */
export const Config: zs<Config> = zs.object({
  mountBackend: zs.boolean().default(true),
  mountTools: zs.boolean().default(true),
  shellDialect: zs.union(['auto', 'bash', 'pwsh'] as const).default('auto'),
  hardenPwshReadLine: zs.boolean().default(true),
  shellArgs: zs.array(zs.string()).default([]),
  timeoutMs: zs.natural().default(300_000),
  startupTimeoutMs: zs.natural().default(20_000),
  startupAttempts: zs.natural().default(3),
  sendWaitMs: zs.natural().default(10_000),
})
