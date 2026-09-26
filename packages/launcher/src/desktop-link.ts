import process from 'node:process'

/**
 * 桌面壳与 launcher 之间的有界控制通道（计划 S3.2 的最小实现）。
 *
 * launcher 以 `--desktop` 运行时：结构化状态以 NDJSON 行写到 stdout，
 * 每行带固定前缀，桌面壳只认前缀行，其余输出（banner、子进程日志）
 * 全部视作普通日志。控制命令从 stdin 逐行读入。两端只共享这一个
 * 模块里声明的消息形态；桌面壳在 Go 侧有自己的镜像类型（backend.go），
 * 改这里必须同步改那边，fixture 测试（tests/desktop-link.spec.ts）锁定字段。
 */

/** 状态行前缀；桌面壳按它过滤，普通日志绝不包含这个字节序列。 */
export const DESKTOP_LINE_PREFIX = '@@DSH_STATION '

/** 后台生命周期阶段；顺序即启动顺序（relay 最先起，等待页由它承担）。 */
export type DesktopPhase =
  | 'config'
  | 'relay'
  | 'plugins'
  | 'dsh'
  | 'ready'
  | 'restarting'
  | 'stopping'
  | 'failed'

export interface DesktopUrls {
  /** 本机入口（浏览器与内置窗口都用它）。 */
  readonly local: string
  /** 本机管理控制台。 */
  readonly admin: string
  /** dsh 自己的 loopback 地址（诊断用）。 */
  readonly dsh: string
}

export type DesktopMessage =
  | {
    readonly type: 'status'
    readonly protocol: 1
    readonly phase: DesktopPhase
    readonly pid: number
    /** 阶段切换时的人读说明；不含凭据。 */
    readonly detail?: string | undefined
    /** ready 之后始终带上 URL；relay 端口在 config 阶段即已知。 */
    readonly urls?: DesktopUrls | undefined
    /** 管理员是否已初始化（决定首次打开控制台显示设置向导还是登录页）。 */
    readonly adminReady?: boolean | undefined
  }
  | {
    readonly type: 'exit'
    readonly protocol: 1
    /** 桌面壳把它写进诊断；进程退出码本身由 Go 直接观察。 */
    readonly message: string
  }

export interface DesktopCommand {
  readonly type: 'stop'
}

/** stdin 命令回调；解析失败的行静默忽略。 */
export type DesktopCommandHandler = (command: DesktopCommand) => void

/** IO 注入点：生产用 process.stdout/stdin，测试传内存实现。 */
export interface DesktopLinkIo {
  write(text: string): void
  /** 注册行回调（按 \n 切好的行，不含行尾）。 */
  listen(handler: (line: string) => void): void
}

export interface DesktopLink {
  readonly enabled: boolean
  emit(message: DesktopMessage): void
  /** 打开 stdin 命令读取；`stop` 之外的命令类型目前忽略。 */
  listen(handler: DesktopCommandHandler): void
  close(): void
}

const DISABLED: DesktopLink = {
  enabled: false,
  emit: () => undefined,
  listen: () => undefined,
  close: () => undefined,
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function processIo(): DesktopLinkIo {
  let buffered = ''
  return {
    write: (text) => {
      process.stdout.write(text)
    },
    listen: (onLine) => {
      process.stdin.setEncoding('utf8')
      process.stdin.on('data', (chunk: string) => {
        buffered += chunk
        for (;;) {
          const newlineAt = buffered.indexOf('\n')
          if (newlineAt < 0) return
          onLine(buffered.slice(0, newlineAt))
          buffered = buffered.slice(newlineAt + 1)
        }
      })
      process.stdin.on('error', () => undefined)
      process.stdin.resume()
    },
  }
}

/** 以 `--desktop` 语义启用；`protocol` 固定为 1，升级时旧壳会响亮失败。 */
export function createDesktopLink(argv: readonly string[], io: DesktopLinkIo = processIo()): DesktopLink {
  if (!argv.includes('--desktop')) return DISABLED

  return {
    enabled: true,
    emit(message: DesktopMessage): void {
      io.write(`${DESKTOP_LINE_PREFIX}${JSON.stringify(message)}\n`)
    },
    listen(handler: DesktopCommandHandler): void {
      io.listen((rawLine) => {
        const line = rawLine.trim()
        if (line === '') return
        try {
          const parsed: unknown = JSON.parse(line)
          if (isObject(parsed) && parsed.type === 'stop') handler({ type: 'stop' })
        } catch {
          // 控制通道只接受完整 JSON 行；坏行忽略，不中断进程。
        }
      })
    },
    close(): void {
      // stdin 由进程退出统一回收；这里保留显式关闭点便于将来扩展。
    },
  }
}
