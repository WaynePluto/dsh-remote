/** 设置写入契约：此处说明命名空间、校验、回读确认和草稿保留。（涉及：`en`、`zh`） */

/** 设置写入契约：此处说明命名空间、校验、回读确认和草稿保留。 */
export const en = {
  nav: 'Proxy',
  title: 'Outbound proxy',
  intro: 'Choose the policy for this process’s native fetch and official web fetch. Child processes and independent network libraries may use their own policy.',
  envNote: 'Follow environment uses the proxy dsh installed at launch. Plugin proxy overrides it; force direct ignores it.',
  mode: 'Outbound mode',
  modeEnvironment: 'Follow environment',
  modePlugin: 'Use plugin proxy',
  modeDirect: 'Force direct',
  modeHint: 'The address and bypass list are kept when you change modes.',
  url: 'Proxy address',
  urlHint: 'For example 127.0.0.1:7890 or http://proxy.example.com:8080 — without a scheme, http:// is assumed. The same address is used for http and https.',
  badUrl: 'That is not a proxy address. Write host:port, or http://host:port. A user name or password in the address is not accepted.',
  rejected: 'dsh refused this change and reloaded the stored settings, so nothing was saved. What you typed is still here.',
  bypass: 'Bypass these hosts',
  bypassHint: 'Comma or newline separated. Keep the loopback entries: dsh, the relay, and local model servers talk over them.',
  save: 'Save',
  saving: 'Saving…',
  saved: 'Saved.',
  needUrl: 'Enter an address first — switching the proxy on without one is refused.',
  test: 'Test',
  testing: 'Testing…',
  testUrl: 'Test address',
  statusDirect: 'Current mode: force direct.',
  statusEnvironment: 'Current mode: follow environment (routing depends on the request URL).',
  statusVia: 'Outbound requests go through {url}.',
  statusBypass: 'Bypassing: {bypass}',
  readOnly: 'Settings are read-only in this browser, so the proxy cannot be changed here.',
  loading: 'Loading…',
  unavailable: 'The proxy plugin is not loaded in this dsh, so there is nothing to configure.',
  testOk: 'Reached {url} — HTTP {status} in {ms} ms{via}.',
  testVia: ', through {url}',
  testDirect: ', direct',
  testFailed: 'Could not reach {url}{via}: {error}',
  failed: 'Failed: {message}',
} as const

/** 设置写入契约：此处说明命名空间、校验、回读确认和草稿保留。 */
export type ProxyKey = keyof typeof en

/** 实现说明：此处记录相关接口、边界和生命周期约束。 */
export const zh: Record<ProxyKey, string> = {
  nav: '代理',
  title: '出网代理',
  intro: '选择本进程原生 fetch 与官方网页抓取的出网方式；子进程和独立网络库可能使用各自的策略。',
  envNote: '跟随环境使用 dsh 启动时安装的代理；插件代理优先覆盖；强制直连忽略它。',
  mode: '出网方式',
  modeEnvironment: '跟随环境',
  modePlugin: '使用插件代理',
  modeDirect: '强制直连',
  modeHint: '切换方式仍保留代理地址和绕过列表。',
  url: '代理地址',
  urlHint: '例如 127.0.0.1:7890 或 http://proxy.example.com:8080——不写协议就按 http:// 处理。http 和 https 用同一个地址。',
  badUrl: '这不是一个代理地址。写成 主机:端口 或 http://主机:端口。地址里不接受用户名和密码。',
  rejected: 'dsh 拒绝了这次修改并重新载入了已存的设置，所以什么都没保存。你刚才输入的内容还在。',
  bypass: '不走代理的地址',
  bypassHint: '用逗号或换行分隔。请保留本机回环地址：dsh、relay 与本地模型服务都走它们。',
  save: '保存',
  saving: '正在保存…',
  saved: '已保存。',
  needUrl: '请先填代理地址——没有地址就打开开关会被拒绝。',
  test: '测试',
  testing: '正在测试…',
  testUrl: '测试地址',
  statusDirect: '当前：强制直连。',
  statusEnvironment: '当前：跟随环境；具体路由取决于请求地址。',
  statusVia: '当前：出网请求走 {url}。',
  statusBypass: '不走代理：{bypass}',
  readOnly: '这个浏览器里的设置是只读的，改不了代理。',
  loading: '正在读取…',
  unavailable: '这个 dsh 没有加载代理插件，没有可配置的内容。',
  testOk: '连通 {url}——HTTP {status}，耗时 {ms} 毫秒{via}。',
  testVia: '，经 {url}',
  testDirect: '，直连',
  testFailed: '连不上 {url}{via}：{error}',
  failed: '失败：{message}',
}

/** 实现说明：此处记录相关接口、边界和生命周期约束。（涉及：`{name}`） */
export function fill(text: string, values: Readonly<Record<string, string | number>>): string {
  return text.replace(/\{(\w+)\}/gu, (match, key: string) =>
    Object.hasOwn(values, key) ? String(values[key]) : match)
}
