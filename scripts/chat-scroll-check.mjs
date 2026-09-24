/**
 * 在不启动 dsh 或打开会话的情况下，对 chat-scroll 浏览器产物做冒烟检查。
 * 它在小型浏览器模块 shim 中执行构建后的加载器包装，并验证两个槽注册以及
 * 原生回到底部动画衔接处。
 *
 * 构建插件后运行：
 *
 *   用法：node scripts/chat-scroll-check.mjs
 */

import { createContext, runInContext } from 'node:vm'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from './local-config.mjs'

const PACKAGE_ID = '@dsh-station/dsh-plugin-chat-scroll'
const BUNDLE = join(ROOT, 'packages', 'plugins', 'chat-scroll', 'dist', 'client.js')
const NOOP = () => {}
let failures = 0

function check(ok, message, detail) {
  if (!ok) failures += 1
  console.log(`${ok ? '[ok]  ' : '[fail]'} ${message}${detail === undefined ? '' : ` — ${detail}`}`)
}

if (!existsSync(BUNDLE)) {
  console.error(`找不到 ${BUNDLE}，先运行 pnpm --filter ${PACKAGE_ID} build`)
  process.exit(1)
}

const source = readFileSync(BUNDLE, 'utf8')
let loaded = null
const react = {
  useCallback: (_fn) => NOOP,
  useEffect: NOOP,
  useRef: () => ({ current: null }),
}
const sandbox = {
  window: { __ModuleLoader__: { load: entry => { loaded = entry } } },
  console,
}
runInContext(source, createContext(sandbox), { filename: BUNDLE })
check(loaded?.id === PACKAGE_ID, 'browser loader id 使用 chat-scroll 包名', loaded?.id)
if (loaded === null) process.exit(1)

const exports = loaded.factory(id => {
  if (id === 'react') return react
  if (id === 'react/jsx-runtime') return { Fragment: NOOP, jsx: NOOP, jsxs: NOOP }
  if (id === '@deepseek-ai/dsh-client-ui-primitives') return { IconChevronUpOutline14: NOOP, Tooltip: NOOP }
  throw new Error(`bundle 要求页面模块表之外的模块：${id}`)
})
const registrations = []
const namespaces = []
const context = {
  effect: run => { run(); return NOOP },
  locale: { register: namespace => { namespaces.push(namespace); return NOOP } },
  slots: {
    inject: (_name, run) => { run() },
    register: options => { registrations.push(options); return NOOP },
  },
}
exports.apply(context)
const assistant = registrations.find(entry => entry.name === 'conversation.chat.assistant-actions')
const dock = registrations.find(entry => entry.name === 'conversation.input.dock')
check(namespaces.includes('dsh-plugin-chat-scroll'), '注册 chat-scroll 文案命名空间')
check(assistant?.id === 'dsh-plugin-chat-scroll', '注册消息开头动作', JSON.stringify(assistant))
check(dock?.id === 'dsh-plugin-chat-scroll-navigation', '注册会话级底部导航 mount', JSON.stringify(dock))
check(source.includes('requestAnimationFrame'), 'bundle 包含逐帧滚动动画')
check(source.includes('Back to bottom') && source.includes('回到底部'), 'bundle 包含中英文原生按钮识别文案')
check(source.includes('dshx-chat-scroll-cushion'), 'bundle 包含尾部空间协调属性')
console.log(failures === 0 ? '\n全部通过。' : `\n${failures} 项未通过。`)
process.exit(failures === 0 ? 0 : 1)
