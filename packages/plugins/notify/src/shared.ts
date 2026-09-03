/**
 * The handful of facts both halves of this plugin have to agree on.
 *
 * This module is imported by the Host half AND compiled into the browser
 * bundle, so it must stay free of Node built-ins and of every dsh package: the
 * client program (`tsconfig.client.json`) type-checks it with `"types": []`.
 *
 * @module @dsh-remote/dsh-plugin-notify/shared
 */

/**
 * The settings namespace this plugin owns, and the copy namespace of its page.
 *
 * The package name, per AGENTS.md: a shared `settings.yaml` shows at a glance
 * which plugin a section belongs to, and it cannot collide with a namespace dsh
 * itself may add upstream.
 */
export const NAMESPACE = 'dsh-plugin-notify'

/** The private RPC channel the page's "send a test notification" button calls. */
export const CHANNEL = '/notify'

/** The one endpoint of {@link CHANNEL}. */
export const TEST_ENDPOINT = 'test'

/** This plugin's settings section. */
export interface NotifySettings {
  /**
   * The master switch.
   *
   * Default ON: a person installs a notification plugin because they want to
   * stop watching the page, and a notifier that has to be switched on after
   * installation is a notifier that stays silent through the one long task it
   * was installed for.
   */
  enabled: boolean
  /**
   * Whether an approval card or a question that nobody answers also raises a
   * notification.
   *
   * Separate from {@link enabled} because it is the one that can fire while
   * somebody IS watching: a person who keeps the tab open all day may want the
   * "your turn finished" toast and not the "a tool wants permission" one.
   */
  waiting: boolean
}

/** Every field of the section, in write order. */
export const FIELDS = ['enabled', 'waiting'] as const

/**
 * What the plugin does before anyone touches the page.
 *
 * Also the `base` layer of the registered namespace, so these are the values a
 * `settings.yaml` without a `dsh-plugin-notify` section resolves to.
 */
export const DEFAULT_SETTINGS: NotifySettings = {
  enabled: true,
  waiting: true,
}

/** What one test notification did. */
export interface NotifyTestResult {
  /** Whether the platform notifier accepted the toast. */
  ok: boolean
  /** The platform the Host is running on, as `process.platform` reports it. */
  platform: string
  /** How long the notifier took, in milliseconds. */
  elapsedMs: number
  /** Why it failed, when it did. */
  error?: string
}

/**
 * Whether an endpoint name is the one this channel serves.
 * @param endpoint - channel-relative endpoint name.
 * @returns whether it is {@link TEST_ENDPOINT}.
 */
export function isNotifyEndpoint(endpoint: string): endpoint is typeof TEST_ENDPOINT {
  return endpoint === TEST_ENDPOINT
}
