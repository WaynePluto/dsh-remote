/** auth card 文案；`en` 作为 key 集合，`zh` 按它实现。 */

/** 设置写入契约：此处说明命名空间、校验、回读确认和草稿保留。 */
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

/** 设置写入契约：此处说明命名空间、校验、回读确认和草稿保留。 */
export type CopilotKey = keyof typeof en

/** 本 namespace 的文案 key 类型。 */
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

/** 填充文案占位符，未知 key 保持原样。 */
export function fill(text: string, values: Readonly<Record<string, string | number>>): string {
  return text.replace(/\{(\w+)\}/gu, (match, key: string) =>
    Object.hasOwn(values, key) ? String(values[key]) : match)
}
