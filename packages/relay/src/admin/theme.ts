import type { BrowserCookiePolicy } from '../auth/cookies.js'

/**
 * The three appearances dsh itself offers, spelled the same way it does
 * (`packages/client/ui-theme/src/theme-settings.ts`), so a machine's console
 * and the dsh UI behind it offer the same choice rather than two similar ones.
 *
 * The preference is ours alone: dsh keeps its own in its settings document,
 * which relay must not read or write (it never parses dsh's protocol), so the
 * two are set independently and each remembers its own answer.
 */
export type ThemePreference = 'light' | 'dark' | 'system'

/** Same default as dsh: follow the operating system until told otherwise. */
export const DEFAULT_THEME: ThemePreference = 'system'

/**
 * The switch endpoint. Under the `_` prefix like every other relay-owned path,
 * so it can never shadow one the tunnelled dsh frontend owns.
 */
export const THEME_PATH = '/_theme'

/** Cube order copied from dsh's Appearance row: light, dark, system. */
export const THEME_VALUES: readonly ThemePreference[] = ['light', 'dark', 'system']

/** Labels lifted verbatim from dsh's zh-CN dictionary (`settings.theme`). */
const THEME_LABELS: Readonly<Record<ThemePreference, string>> = {
  light: '浅色',
  dark: '深色',
  system: '跟随系统',
}

export function themeLabel(preference: ThemePreference): string {
  return THEME_LABELS[preference]
}

/**
 * Parse a preference off the wire.
 * @param value The raw query parameter or cookie value.
 * @returns The preference, or undefined when the value names none.
 */
export function parseThemePreference(
  value: string | null | undefined,
): ThemePreference | undefined {
  return THEME_VALUES.find(preference => preference === value)
}

/**
 * The appearance a browser asked for, defaulting to `system`.
 *
 * A cookie that is missing, stale or hand-edited resolves to the default
 * instead of failing: this only decides which palette a page renders in.
 * @param cookies The relay's cookie policy, which owns the cookie name.
 * @param cookieHeader The request's raw Cookie header.
 * @returns The preference to render with.
 */
export function readThemePreference(
  cookies: BrowserCookiePolicy,
  cookieHeader: string | undefined,
): ThemePreference {
  return parseThemePreference(cookies.readTheme(cookieHeader)) ?? DEFAULT_THEME
}

/**
 * Where a theme switch may send the browser back to.
 *
 * Same-origin paths only, and never back to `/_theme` itself: the switch is
 * reachable without a session, so an unvalidated parameter would turn it into
 * an open redirect on the login page.
 * @param value The `returnTo` parameter as received.
 * @returns A safe path to redirect to.
 */
export function safeThemeReturnTo(value: string | null | undefined): string {
  if (
    value === null || value === undefined
    || value.length > 2_048
    || !value.startsWith('/')
    || value.startsWith('//')
    || value.startsWith('/\\')
    || value === THEME_PATH
    || value.startsWith(`${THEME_PATH}?`)
  ) {
    return '/'
  }
  return value
}

/** What the server should answer a `/_theme` request with. */
export type ThemeSwitchResult =
  | {
    readonly kind: 'redirect'
    readonly location: string
    readonly setCookie: string
  }
  | {
    readonly kind: 'error'
    readonly status: 400 | 405
    readonly message: string
  }

/**
 * Resolve one `/_theme` request.
 *
 * Deliberately answered before authentication and without a CSRF token: the
 * login page is one of the pages that has to offer the switch, and the only
 * thing a forged request could achieve is showing somebody a dark page.
 * @param options The request method, its parsed URL, and the cookie policy
 * that serializes the preference.
 * @returns The redirect to send, or the error to answer with.
 */
export function resolveThemeSwitch(options: {
  method: string | undefined
  url: URL
  cookies: BrowserCookiePolicy
}): ThemeSwitchResult {
  const { method, url, cookies } = options
  if (method !== 'GET' && method !== 'HEAD') {
    return { kind: 'error', status: 405, message: 'method not allowed' }
  }
  const preference = parseThemePreference(url.searchParams.get('value'))
  if (preference === undefined) {
    return { kind: 'error', status: 400, message: 'unknown theme' }
  }
  return {
    kind: 'redirect',
    location: safeThemeReturnTo(url.searchParams.get('returnTo')),
    setCookie: cookies.themeHeader(preference),
  }
}
