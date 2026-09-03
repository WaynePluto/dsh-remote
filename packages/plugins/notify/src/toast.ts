/**
 * The Windows half of "tell the person at the keyboard".
 *
 * WHY POWERSHELL AND NOT A NATIVE MODULE. 铁律 3: no native modules anywhere on
 * the connector/launcher side, because the green package must work unzipped.
 * `Windows.UI.Notifications` is a WinRT API every Windows install already has,
 * and Windows PowerShell 5.1 can project it in one line — so the dependency is
 * a program that ships with the OS rather than a prebuilt binary per Node ABI.
 *
 * WHY THE TEXT TRAVELS IN THE ENVIRONMENT. The obvious implementation
 * interpolates the title and body into the script and doubles the quotes (this
 * is what the pi extension this plugin is modelled on does). That makes the
 * script a template whose correctness depends on an escaping function, and the
 * text here is not ours: a session title comes from a model, and a tool name
 * comes from whatever registered it. Passing them as environment variables
 * makes the script a CONSTANT — there is no interpolation to get wrong — and
 * `CreateTextNode` escapes them into the XML by construction, so neither
 * PowerShell nor the toast document can be injected into.
 *
 * WHY `scenario=reminder`. It is what makes the toast persist until it is
 * dismissed instead of fading after a few seconds; the scenario requires at
 * least one action, which is why a bare "close" button is appended.
 *
 * @module @dsh-remote/dsh-plugin-notify/toast
 */

import { execFile } from 'node:child_process'

/** One notification, already reduced to what a toast can show. */
export interface Notice {
  /** The bold first line. */
  title: string
  /** The wrapped second line. */
  body: string
}

/** Anything that can put a notice in front of the person at the machine. */
export interface Notifier {
  /**
   * Show one notice.
   * @param notice - the title and body to show.
   * @returns fulfillment once the platform accepted it.
   */
  send(notice: Notice): Promise<void>
}

/**
 * The AppID the toast is shown under; Windows prints it as the sender.
 *
 * ⚠️ An AppID that is not a registered AUMID is tolerated by current Windows 10
 * and 11 builds (verified on this machine — an arbitrary string and PowerShell's
 * own AUMID both raised a visible toast), but it is not contractual: a hardened
 * or older build can accept the call and show nothing. That is why the settings
 * page has a test button — a silent toast is otherwise indistinguishable from a
 * plugin that never fired.
 */
export const APP_ID = 'DeepSeek Harness'

/** The label on the button `scenario=reminder` obliges the toast to carry. */
export const DISMISS_LABEL = '关闭'

/** How long a notifier may take before it is abandoned and killed. */
export const TOAST_TIMEOUT_MS = 10_000

/**
 * How many notifiers may be in flight at once.
 *
 * A cap rather than a queue: notifications are only interesting while they are
 * fresh, so the right response to a burst is to drop the surplus, not to show
 * it late. Reached only if the machine is so loaded that spawning a shell takes
 * longer than a whole turn.
 */
export const MAX_IN_FLIGHT = 4

/** Longest title this plugin sends; Windows truncates, but not predictably. */
export const TITLE_LIMIT = 90

/** Longest body this plugin sends. */
export const BODY_LIMIT = 180

/**
 * The environment variables the constant script reads its text from.
 *
 * Prefixed so they cannot collide with anything the harness itself sets, and
 * named in the script rather than interpolated — see the module note.
 */
export const ENV = {
  title: 'DSH_NOTIFY_TITLE',
  body: 'DSH_NOTIFY_BODY',
  appId: 'DSH_NOTIFY_APPID',
  dismiss: 'DSH_NOTIFY_DISMISS',
} as const

/** WinRT namespace, spelled once. */
const WINRT = 'Windows.UI.Notifications'

/**
 * The complete toast script.
 *
 * A module-level constant on purpose: it contains no caller data, so there is
 * no per-call string building and nothing to escape. Statements are joined with
 * `; ` so the whole thing survives as one `-Command` argument.
 */
export const TOAST_SCRIPT = [
  `[${WINRT}.ToastNotificationManager, ${WINRT}, ContentType = WindowsRuntime] > $null`,
  `$xml = [${WINRT}.ToastNotificationManager]::GetTemplateContent([${WINRT}.ToastTemplateType]::ToastText02)`,
  `$texts = $xml.GetElementsByTagName('text')`,
  `$texts.Item(0).AppendChild($xml.CreateTextNode($env:${ENV.title})) > $null`,
  `$texts.Item(1).AppendChild($xml.CreateTextNode($env:${ENV.body})) > $null`,
  // Persist until dismissed. The scenario is only honoured when the toast
  // carries at least one action, hence the button below.
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

/**
 * Reduce one caller string to something a toast line can hold.
 *
 * Control characters are removed rather than escaped: they cannot break the
 * document (the value never reaches the parser as markup) but a raw newline in
 * a session title makes the toast lay out wrongly, and a NUL cannot be carried
 * in an environment variable at all.
 * @param text - the caller's string.
 * @param limit - the longest result to produce.
 * @returns a single-line string no longer than `limit`.
 */
export function clampLine(text: string, limit: number): string {
  // eslint-disable-next-line no-control-regex -- removing them is the point
  const flat = text.replace(/[\u0000-\u001F\u007F]+/gu, ' ').replace(/\s+/gu, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat
}

/** How this notifier reaches a child process; replaced in tests. */
export type ExecFile = typeof execFile

/** Everything {@link WindowsToastNotifier} lets a test replace. */
export interface WindowsToastOptions {
  /** The platform string to branch on; defaults to `process.platform`. */
  platform?: string
  /** The child-process spawner; defaults to `node:child_process`'s. */
  exec?: ExecFile
  /** The ambient environment the child inherits; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv
  /** The AppID toasts are shown under. */
  appId?: string
}

/**
 * Show notices as persistent Windows toasts, and do nothing anywhere else.
 *
 * Non-Windows is a deliberate silent no-op rather than the terminal-escape
 * fallback the pi extension uses: dsh is a server whose stdout is a log file
 * that somebody reads later, and writing OSC 777 into it produces neither a
 * notification nor a readable log line.
 */
export class WindowsToastNotifier implements Notifier {
  /** Whether this machine can show a toast at all. */
  readonly supported: boolean

  private readonly exec: ExecFile
  private readonly env: NodeJS.ProcessEnv
  private readonly appId: string
  private inFlight = 0

  /**
   * @param options - test seams; every one defaults to the real thing.
   */
  constructor(options: WindowsToastOptions = {}) {
    this.supported = (options.platform ?? process.platform) === 'win32'
    this.exec = options.exec ?? execFile
    this.env = options.env ?? process.env
    this.appId = options.appId ?? APP_ID
  }

  /**
   * Show one toast.
   *
   * Never rejects for a reason the caller can act on — a machine that cannot
   * raise toasts is a fact about the machine, not a failure of the turn that
   * just finished — but it DOES reject when the notifier itself failed, so the
   * settings page's test button can report why.
   * @param notice - the notice to show.
   * @returns fulfillment once the notifier returned.
   * @throws Error when the notifier ran and failed.
   */
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
            // CREATE_NO_WINDOW: without it the child gets a console of its own
            // and Windows retitles the terminal dsh was started from.
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
