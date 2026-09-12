/**
 * Windows 通知实现。使用系统自带 PowerShell 和 WinRT API，不引入原生 Node 模块；标题与正文通过环境变量传给固定脚本，避免把模型或工具输入插值进 PowerShell/XML。
 *
 * @module @dsh-remote/dsh-plugin-notify/toast
 */

import { execFile } from 'node:child_process'

/** 已压缩到 toast 可显示范围的一条通知。 */
export interface Notice {
  /** 加粗的第一行。 */
  title: string
  /** 换行显示的第二行。 */
  body: string
}

/** 能把通知呈现在机器前用户面前的对象。 */
export interface Notifier {
  /** 显示一条通知；平台接受后 resolve。 */
  send(notice: Notice): Promise<void>
}

/** toast 使用的 AppID；Windows 将其显示为发送者。 */
export const APP_ID = 'DeepSeek Harness'

/** `scenario=reminder` 要求 toast 携带的按钮标签。 */
export const DISMISS_LABEL = '关闭'

/** 通知器等待多久后放弃并终止。 */
export const TOAST_TIMEOUT_MS = 10_000

/** 同时运行的 notifier 上限；通知过期后不排队，超额直接丢弃。 */
export const MAX_IN_FLIGHT = 4

/** 本插件发送的标题最大长度；Windows 会截断但规则不稳定。 */
export const TITLE_LIMIT = 90

/** 本插件发送的正文最大长度。 */
export const BODY_LIMIT = 180

/** 固定 PowerShell script 从环境变量读取的文本；使用前缀避免与 harness 环境冲突。 */
export const ENV = {
  title: 'DSH_NOTIFY_TITLE',
  body: 'DSH_NOTIFY_BODY',
  appId: 'DSH_NOTIFY_APPID',
  dismiss: 'DSH_NOTIFY_DISMISS',
} as const

/** WinRT namespace，集中定义一次。 */
const WINRT = 'Windows.UI.Notifications'

/** 完整且不插值的 toast script；用 `; ` 拼成一个 `-Command` 参数。 */
export const TOAST_SCRIPT = [
  `[${WINRT}.ToastNotificationManager, ${WINRT}, ContentType = WindowsRuntime] > $null`,
  `$xml = [${WINRT}.ToastNotificationManager]::GetTemplateContent([${WINRT}.ToastTemplateType]::ToastText02)`,
  `$texts = $xml.GetElementsByTagName('text')`,
  `$texts.Item(0).AppendChild($xml.CreateTextNode($env:${ENV.title})) > $null`,
  `$texts.Item(1).AppendChild($xml.CreateTextNode($env:${ENV.body})) > $null`,
  // 持续显示直到关闭。该 scenario 只有在 toast
  // 至少包含一个 action 时才生效，因此需要下面的按钮。
  `$xml.DocumentElement.SetAttribute('scenario', 'reminder')`,
  `$actions = $xml.CreateElement('actions')`,
  `$action = $xml.CreateElement('action')`,
  `$action.SetAttribute('content', $env:${ENV.dismiss})`,
  `$action.SetAttribute('arguments', 'dismiss')`,
  `$action.SetAttribute('activationType', 'system')`,
  `$actions.AppendChild($action) > $null`,
  `$xml.DocumentElement.AppendChild($actions) > $null`,
  `$toast = [${WINRT}.ToastNotification]::new($xml)`,
  `[${WINRT}.ToastNotificationManager]::CreateToastNotifier($env:${ENV.appId}).Show($toast)`,
].join('; ')

/** 去除控制字符、压平为单行并截断到 toast 可容纳的长度。 */
export function clampLine(text: string, limit: number): string {
  // 发送前先移除控制字符；原始换行会破坏 toast layout。
  // eslint-disable-next-line no-control-regex -- 中文说明：移除控制字符就是这里的目的。
  const flat = text.replace(/[\u0000-\u001F\u007F]+/gu, ' ').replace(/\s+/gu, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat
}

/** 可替换的 child-process spawner，供测试使用。 */
export type ExecFile = typeof execFile

/** WindowsToastNotifier 的测试 seams。 */
export interface WindowsToastOptions {
  /** 分支使用的平台字符串；默认 `process.platform`。 */
  platform?: string
  /** child-process spawner；默认 `node:child_process` 的 `execFile`。 */
  exec?: ExecFile
  /** child 继承的环境；默认 `process.env`。 */
  env?: NodeJS.ProcessEnv
  /** toast 使用的 AppID。 */
  appId?: string
}

/** 仅在 Windows 显示持久 toast；其他平台是刻意的 silent no-op。 */
export class WindowsToastNotifier implements Notifier {
  /** 当前机器是否支持 toast。 */
  readonly supported: boolean

  private readonly exec: ExecFile
  private readonly env: NodeJS.ProcessEnv
  private readonly appId: string
  private inFlight = 0

  /** 注入测试 seams；未提供时使用真实平台实现。 */
  constructor(options: WindowsToastOptions = {}) {
    this.supported = (options.platform ?? process.platform) === 'win32'
    this.exec = options.exec ?? execFile
    this.env = options.env ?? process.env
    this.appId = options.appId ?? APP_ID
  }

  /** 显示一条 toast；平台不支持时静默返回，notifier 真正失败时 reject 供 test button 报告。 */
  async send(notice: Notice): Promise<void> {
    if (!this.supported) return
    if (this.inFlight >= MAX_IN_FLIGHT) return
    this.inFlight += 1
    try {
      await new Promise<void>((resolve, reject) => {
        this.exec(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-Command', TOAST_SCRIPT],
          {
            // CREATE_NO_WINDOW：否则子进程会拥有自己的控制台
            // Windows 会改写启动 dsh 的终端标题。
            windowsHide: true,
            timeout: TOAST_TIMEOUT_MS,
            env: {
              ...this.env,
              [ENV.title]: clampLine(notice.title, TITLE_LIMIT),
              [ENV.body]: clampLine(notice.body, BODY_LIMIT),
              [ENV.appId]: this.appId,
              [ENV.dismiss]: DISMISS_LABEL,
            },
          },
          (error) => { if (error === null) resolve(); else reject(error) },
        )
      })
    } finally {
      this.inFlight -= 1
    }
  }
}
