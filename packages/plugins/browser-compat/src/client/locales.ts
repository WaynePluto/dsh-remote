/** 浏览器兼容与临时诊断设置页文案。 */

/** 英文文案；同时是本命名空间的 key 集合。 */
export const en = {
  nav: 'Browser diagnostics',
  title: 'Browser compatibility and errors',
  intro: 'This page only shows errors and warnings collected by the current browser page. Nothing is saved or uploaded; closing or refreshing the page clears it.',
  capabilities: 'Compatibility checks',
  capabilityNative: 'Native',
  capabilityPolyfilled: 'Compatibility fix',
  capabilityMissing: 'Unavailable',
  capabilityRequired: 'Core',
  capabilityOptional: 'Optional',
  errors: 'Browser errors',
  entryCount: '{count} unique entries',
  empty: 'No browser errors have been collected in this page yet.',
  clear: 'Clear log',
  copy: 'Copy',
  copied: 'Copied',
  copyFailed: 'Copy failed. Select the text manually.',
  occurrence: '{count} occurrences',
  firstSeen: 'First: {time}',
  lastSeen: 'Last: {time}',
  context: 'Context: {value}',
  source: 'Source: {value}',
  stack: 'Stack',
  unavailable: 'The early browser diagnostics bridge is unavailable.',
  error: 'Error',
  warning: 'Warning',
  js: 'JavaScript',
  css: 'CSS',
} as const

/** 本命名空间的一个文案 key。 */
export type BrowserCompatKey = keyof typeof en

/** 简体中文文案。 */
export const zh: Record<BrowserCompatKey, string> = {
  nav: '浏览器日志',
  title: '浏览器兼容与错误',
  intro: '这里只显示当前浏览器页面实时收集的错误和警告，不保存、不上传；关闭或刷新页面后日志会清空。',
  capabilities: '兼容性检查',
  capabilityNative: '原生支持',
  capabilityPolyfilled: '已安装垫片',
  capabilityMissing: '不可用',
  capabilityRequired: '核心能力',
  capabilityOptional: '可选能力',
  errors: '浏览器错误日志',
  entryCount: '{count} 个不同问题',
  empty: '当前页面还没有收集到浏览器错误。',
  clear: '清空日志',
  copy: '复制',
  copied: '已复制',
  copyFailed: '复制失败，请手动选择文本。',
  occurrence: '出现 {count} 次',
  firstSeen: '首次：{time}',
  lastSeen: '最近：{time}',
  context: '上下文：{value}',
  source: '来源：{value}',
  stack: '堆栈',
  unavailable: '页面启动时的浏览器诊断桥不可用。',
  error: '错误',
  warning: '警告',
  js: 'JavaScript',
  css: 'CSS',
}

/** 替换文案中的简单占位符。 */
export function fill(text: string, values: Readonly<Record<string, string | number>>): string {
  return text.replace(/\{(\w+)\}/gu, (match, key: string) =>
    Object.hasOwn(values, key) ? String(values[key]) : match)
}
