/**
 * Copy for the Copilot sign-in area. Both dictionaries are complete by
 * construction: `en` defines the key set and `zh` is typed against it, so a
 * missing translation fails the build rather than falling back to English at
 * runtime.
 *
 * @module @dsh-remote/dsh-plugin-copilot-auth/client/locales
 */

/** English copy; also the key set of this namespace. */
export const en = {
  title: 'GitHub Copilot subscription',
  intro: 'Sign in with GitHub to use your Copilot subscription. No API key is needed.',
  signIn: 'Sign in with GitHub',
  signInAgain: 'Sign in again',
  signOut: 'Sign out',
  cancel: 'Cancel',
  starting: 'Contacting GitHub…',
  finishing: 'Finishing sign-in…',
  awaiting: 'Open the page below and enter this code:',
  openPage: 'Open GitHub device page',
  copy: 'Copy',
  copied: 'Copied',
  expiresIn: 'The code expires in {minutes} min.',
  expired: 'The code has expired. Start again.',
  signedIn: 'Signed in. {count} models available.',
  signedInUnknown: 'Signed in.',
  routeMissing: 'Signed in, but these models are not in the picker yet.',
  configure: 'Add the models',
  failed: 'Sign-in failed: {message}',
  routeFailed: 'The models could not be written to settings: {message}',
  busy: 'Working…',
} as const

/** One copy key of this namespace. */
export type CopilotKey = keyof typeof en

/** Simplified Chinese copy. */
export const zh: Record<CopilotKey, string> = {
  title: 'GitHub Copilot 订阅',
  intro: '用 GitHub 账号登录即可使用 Copilot 订阅，不需要填 API 密钥。',
  signIn: '用 GitHub 账号登录',
  signInAgain: '重新登录',
  signOut: '退出登录',
  cancel: '取消',
  starting: '正在连接 GitHub…',
  finishing: '正在完成登录…',
  awaiting: '打开下面的页面并输入这个代码：',
  openPage: '打开 GitHub 授权页',
  copy: '复制',
  copied: '已复制',
  expiresIn: '代码 {minutes} 分钟后失效。',
  expired: '代码已失效，请重新登录。',
  signedIn: '已登录，可用模型 {count} 个。',
  signedInUnknown: '已登录。',
  routeMissing: '已登录，但模型还没有出现在选择器里。',
  configure: '把模型加进来',
  failed: '登录失败：{message}',
  routeFailed: '模型没能写进设置：{message}',
  busy: '处理中…',
}

/**
 * Fill `{name}` placeholders in one copy string.
 * @param text - the translated string.
 * @param values - placeholder values by name.
 * @returns the filled string; an unknown placeholder is left as written.
 */
export function fill(text: string, values: Readonly<Record<string, string | number>>): string {
  return text.replace(/\{(\w+)\}/gu, (match, key: string) =>
    Object.hasOwn(values, key) ? String(values[key]) : match)
}
