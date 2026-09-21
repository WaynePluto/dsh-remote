/**
 * dsh-remote 精简代理预设的真实宿主端冒烟检查。
 *
 * 每次升级 dsh 后运行：
 *
 *   用法：node scripts/concise-mode-check.mjs [--port 3100]
 *
 * 探针只挂载一个常驻预设作用域并读取注册表数据，不发起模型请求，也不创建会话。
 */

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { DSH_BIN, DSH_PROFILE, DEFAULT_PROFILE_BUNDLES, ROOT, dshPluginOverlays } from './local-config.mjs'

const CHANNEL = '/concise-mode-check'
const portAt = process.argv.indexOf('--port')
const PORT = portAt < 0 ? 3100 : Number(process.argv[portAt + 1])
if (!Number.isSafeInteger(PORT) || PORT < 1 || PORT > 65535) {
  throw new TypeError('--port must be an integer from 1 to 65535')
}
const AUTHORITY = '127.0.0.1:' + PORT
const BASE = 'http://' + AUTHORITY
const HOME = mkdtempSync(join(tmpdir(), 'dsh-concise-mode-check-'))
const PROBE = join(HOME, 'concise-mode-check-probe.mjs')
const OVERLAY = join(HOME, 'concise-mode-check-overlay.yml')
const PROJECT_GLOBAL_TOOLS = [
  'service_list', 'service_logs', 'service_restart', 'service_start', 'service_stop',
  'interactive_terminal',
]
const EXPECTED_TOOLS = [
  'read', 'read_image', 'write', 'edit', 'glob', 'grep', 'skill', 'subagent',
  'ask_user_question', 'todo_write', process.platform === 'win32' ? 'pwsh' : 'bash',
  ...PROJECT_GLOBAL_TOOLS,
]
const EXPECTED_PTC_REGISTRY_TOOLS = [...EXPECTED_TOOLS, 'run_code']
const EXPECTED_SECTIONS = [
  { name: 'deployment:persona-prefix', text: 'You are a helpful software engineer assistant.' },
]
const EXPECTED_CONTEXTS = []
const PROBE_SOURCE = [
  "export const inject = ['agentPresets', 'tools', 'systemPrompt', 'connection']",
  '',
  "const fields = ['id', 'trust', 'name', 'description', 'order', 'broken']",
  'function ownedPreset(preset) {',
  '  const owned = {}',
  '  for (const field of fields) {',
  '    if (preset[field] !== undefined) owned[field] = preset[field]',
  '  }',
  '  return owned',
  '}',
  'function ownedPrompt(entry) {',
  '  return { name: entry.name, text: entry.text }',
  '}',
  'async function snapshotFor(ctx, id) {',
  '  const scope = await ctx.agentPresets.standingKeyFor(id)',
  '  const prompt = await ctx.systemPrompt.assemble({ scope })',
  '  const schemas = ctx.tools.schemas(scope)',
  '  return {',
  '    tools: schemas.map(schema => schema.name),',
  '    parameterNames: Object.fromEntries(schemas.map(schema => [schema.name, Object.keys(schema.parameters.properties ?? {})])),',
  '    wireTools: prompt.tools.map(schema => schema.name),',
  '    systemPrompt: {',
  '      sections: prompt.sections.map(ownedPrompt),',
  '      contexts: prompt.contexts.map(ownedPrompt),',
  '    },',
  '  }',
  '}',
  'export function apply(ctx) {',
  "  const dispose = ctx.connection.rpc.handle('/concise-mode-check', async (endpoint) => {",
  "    if (endpoint !== 'snapshot') {",
  '      return { ok: false, error: {',
  "        code: 'concise-mode-check/unknown-endpoint',",
  "        message: 'unknown endpoint ' + endpoint,",
  '        details: {},',
  '      } }',
  '    }',
  '    const roster = await ctx.agentPresets.list()',
  "    const concise = await snapshotFor(ctx, 'concise')",
  "    const concisePtc = await snapshotFor(ctx, 'concise-ptc')",
  '    return { ok: true, value: {',
  '      roster: roster.map(ownedPreset),',
  '      concise,',
  '      concisePtc,',
  '      globalTools: ctx.tools.schemas().map(schema => schema.name),',
  '    } }',
  '  })',
  "  ctx.effect(() => () => void dispose(), 'concise-mode-check: private RPC probe')",
  '}',
  '',
].join('\n')

let failures = 0
function check(ok, label, detail) {
  if (!ok) failures += 1
  console.log((ok ? '[ok]  ' : '[fail]') + label + (detail === undefined ? '' : ' — ' + detail))
}
function browserHeaders(cookie) {
  return {
    host: AUTHORITY,
    origin: BASE,
    'sec-fetch-site': 'same-origin',
    ...(cookie === undefined ? {} : { cookie }),
  }
}
function prepareHome() {
  // 与 launcher/profile.ts 同一份默认 Bundle 清单（local-config 复制，launcher 为权威）：
  // 检查必须在发行装载形态（全部受管 Bundle）下验证 concise 预设。
  const profile = join(HOME, 'profiles', DSH_PROFILE)
  mkdirSync(profile, { recursive: true })
  writeFileSync(join(profile, 'package.json'), `${JSON.stringify({
    name: `dsh-profile-${DSH_PROFILE}`,
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: DEFAULT_PROFILE_BUNDLES } },
  }, null, 2)}\n`)
  writeFileSync(join(profile, 'cordis.patch.yml'), '[]\n')
  writeFileSync(join(profile, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n')
  writeFileSync(PROBE, PROBE_SOURCE, 'utf8')
  writeFileSync(OVERLAY, "- insert:\n    - id: concise-mode-check\n      name: './concise-mode-check-probe.mjs'\n", 'utf8')
}

/**
 * 单独返回生成的子进程和就绪 Promise。调用方会在等待就绪前赋值 child，
 * 这样就绪失败时不会泄漏进程。
 */
function startDsh() {
  const overlays = [...dshPluginOverlays(), OVERLAY]
  // bundle 定位器不能使用环境变量，因为 local-config
  // 已经通过 createRequire 从真实的 launcher 依赖中解析 DSH_BIN。
  const child = spawn(process.execPath, [
    DSH_BIN, '--profile', DSH_PROFILE,
    ...overlays.flatMap(overlay => ['--patch', overlay]),
    '--no-open', '--host', '127.0.0.1', '--port', String(PORT),
    '--trusted-host', AUTHORITY,
  ], {
    cwd: ROOT,
    env: { ...process.env, DSH_HOME: HOME },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  })
  const ready = new Promise((resolve, reject) => {
    let output = ''
    let settled = false
    const timer = setTimeout(() => finish(reject,
      new Error('dsh did not print a launch token within 60 seconds:\n' + output)), 60000)
    function finish(action, value) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      action(value)
    }
    function scan(chunk) {
      output = (output + String(chunk)).slice(-128000)
      const match = /dsh web:\s*(\S+)/u.exec(output)
      if (match === null) return
      try {
        const token = new URL(match[1]).searchParams.get('token')
        if (token) finish(resolve, token)
      } catch {
        // 部分输出块很正常；后续有更多输出时再次扫描。
      }
    }
    child.stdout.on('data', scan)
    child.stderr.on('data', scan)
    child.once('error', error => finish(reject, error))
    child.once('exit', (code, signal) => finish(reject,
      new Error('dsh exited before readiness (code=' + code + ', signal=' + signal + '):\n' + output)))
  })
  return { child, ready }
}

async function stopChildTree(child) {
  if (child?.pid === undefined) return
  if (process.platform === 'win32') {
    await new Promise(resolve => {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
      killer.once('error', resolve)
      killer.once('exit', resolve)
    })
    return
  }
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error
  }
  await delay(1500)
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error
  }
}

async function exchangeCookie(token) {
  const response = await fetch(BASE + '/?token=' + encodeURIComponent(token), {
    redirect: 'manual', headers: browserHeaders(),
  })
  const setCookies = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie')].filter(Boolean)
  const cookie = setCookies.map(value => value.split(';', 1)[0]).join('; ')
  if (response.status !== 303 || cookie === '') {
    throw new Error('token exchange failed: status=' + response.status + ', cookie=' + (cookie ? 'present' : 'absent'))
  }
  return cookie
}

async function takeSnapshot(cookie) {
  const rpcId = randomUUID()
  const response = await fetch(BASE + CHANNEL + '/snapshot', {
    method: 'POST',
    headers: { ...browserHeaders(cookie), 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId, method: 'snapshot', payload: {} }),
  })
  const text = await response.text()
  let body
  try { body = JSON.parse(text) } catch {
    throw new Error('snapshot returned non-JSON: status=' + response.status + ', body=' + text.slice(0, 500))
  }
  if (response.status !== 200 || body?.type !== 'server-response'
    || body?.rpcId !== rpcId || body?.result?.ok !== true) {
    throw new Error('snapshot RPC failed: status=' + response.status + ', body=' + JSON.stringify(body).slice(0, 1000))
  }
  return body.result.value
}

function diagnoseTools(actual, expectedTools, label) {
  const expected = new Set(expectedTools)
  const actualSet = new Set(actual)
  const missing = expectedTools.filter(name => !actualSet.has(name)).toSorted()
  const unexpected = [...actualSet].filter(name => !expected.has(name)).toSorted()
  const counts = new Map()
  for (const name of actual) counts.set(name, (counts.get(name) ?? 0) + 1)
  const duplicates = [...counts].filter(([, count]) => count > 1)
    .map(([name, count]) => name + '×' + count).toSorted()
  const detail = 'expected total=' + expectedTools.length
    + '; actual total=' + actual.length
    + '; missing=[' + missing.join(', ') + ']'
    + '; unexpected=[' + unexpected.join(', ') + ']'
    + '; duplicates=[' + duplicates.join(', ') + ']'
  check(missing.length === 0 && unexpected.length === 0 && duplicates.length === 0
    && actual.length === expectedTools.length, label + ' tool set is exact', detail)
}

function diagnoseForbidden(actual) {
  const groups = [
    ['job_*', name => name.startsWith('job_')],
    ['goal tools create_goal/get_goal/update_goal', name => ['create_goal', 'get_goal', 'update_goal'].includes(name)],
    ['exit_plan_mode', name => name === 'exit_plan_mode'],
    ['workflow', name => name === 'workflow'],
    ['ralph', name => name === 'ralph'],
    ['web_*', name => name.startsWith('web_')],
    ['subagent_fork', name => name === 'subagent_fork'],
    ['control tools interrupt_agent/list_agents/send_message',
      name => ['interrupt_agent', 'list_agents', 'send_message'].includes(name)],
  ]
  for (const [label, forbidden] of groups) {
    const present = actual.filter(forbidden).toSorted()
    check(present.length === 0, 'forbidden ' + label + ' absent', 'present=[' + present.join(', ') + ']')
  }
}

async function main() {
  let child
  try {
    prepareHome()
    const launch = startDsh()
    child = launch.child
    const token = await launch.ready
    const cookie = await exchangeCookie(token)
    await delay(1000)
    const value = await takeSnapshot(cookie)
    check(true, 'snapshot RPC completed, so concise standing mount succeeded')

    const roster = Array.isArray(value?.roster) ? value.roster : []
    const concisePreset = roster.find(preset => preset?.id === 'concise')
    check(concisePreset !== undefined, 'concise preset exists in the roster')
    check(concisePreset?.name === '简洁模式', 'concise preset name is exactly 简洁模式',
      'actual=' + JSON.stringify(concisePreset?.name))
    check(concisePreset !== undefined && !Object.hasOwn(concisePreset, 'broken'),
      'concise preset has no broken property', 'keys=[' + Object.keys(concisePreset ?? {}).toSorted().join(', ') + ']')

    const concisePtcPreset = roster.find(preset => preset?.id === 'concise-ptc')
    check(concisePtcPreset !== undefined, 'concise-ptc preset exists in the roster')
    check(concisePtcPreset?.name === '简洁 PTC 模式', 'concise-ptc preset name is exactly 简洁 PTC 模式',
      'actual=' + JSON.stringify(concisePtcPreset?.name))
    check(concisePtcPreset !== undefined && !Object.hasOwn(concisePtcPreset, 'broken'),
      'concise-ptc preset has no broken property', 'keys=[' + Object.keys(concisePtcPreset ?? {}).toSorted().join(', ') + ']')

    const globalTools = Array.isArray(value?.globalTools) ? value.globalTools : []
    const sortedGlobalTools = globalTools.toSorted()
    const sortedExpectedGlobals = PROJECT_GLOBAL_TOOLS.toSorted()
    check(JSON.stringify(sortedGlobalTools) === JSON.stringify(sortedExpectedGlobals),
      'project tools are exactly the six global tools',
      'expected=[' + sortedExpectedGlobals.join(', ') + ']; actual=[' + sortedGlobalTools.join(', ') + ']')

    const conciseTools = Array.isArray(value?.concise?.tools) ? value.concise.tools : []
    diagnoseTools(conciseTools, EXPECTED_TOOLS, 'concise')
    diagnoseForbidden(conciseTools)
    const conciseParameters = value?.concise?.parameterNames ?? {}
    for (const tool of [process.platform === 'win32' ? 'pwsh' : 'bash', 'subagent']) {
      check(Array.isArray(conciseParameters[tool]) && !conciseParameters[tool].includes('run_in_background'),
        'concise ' + tool + ' schema omits run_in_background')
    }
    const conciseSections = value?.concise?.systemPrompt?.sections
    const conciseContexts = value?.concise?.systemPrompt?.contexts
    check(JSON.stringify(conciseSections) === JSON.stringify(EXPECTED_SECTIONS),
      'concise system prompt sections are exact', 'actual=' + JSON.stringify(conciseSections))
    check(JSON.stringify(conciseContexts) === JSON.stringify(EXPECTED_CONTEXTS),
      'concise system prompt contexts are exactly empty', 'actual=' + JSON.stringify(conciseContexts))

    const ptcTools = Array.isArray(value?.concisePtc?.tools) ? value.concisePtc.tools : []
    diagnoseTools(ptcTools, EXPECTED_PTC_REGISTRY_TOOLS, 'concise-ptc registry')
    diagnoseForbidden(ptcTools)
    const ptcParameters = value?.concisePtc?.parameterNames ?? {}
    for (const tool of [process.platform === 'win32' ? 'pwsh' : 'bash', 'subagent']) {
      check(Array.isArray(ptcParameters[tool]) && !ptcParameters[tool].includes('run_in_background'),
        'concise-ptc ' + tool + ' schema omits run_in_background')
    }
    const ptcWireTools = Array.isArray(value?.concisePtc?.wireTools) ? value.concisePtc.wireTools : []
    check(JSON.stringify(ptcWireTools) === JSON.stringify(['run_code']),
      'concise-ptc exposes only run_code to the model', 'actual=[' + ptcWireTools.join(', ') + ']')
    const ptcSections = Array.isArray(value?.concisePtc?.systemPrompt?.sections)
      ? value.concisePtc.systemPrompt.sections : []
    const ptcOnly = ptcSections.find(section => section?.name === 'tools:ptc-only')?.text
    const sdk = ptcSections.find(section => section?.name === 'tools:sdk')?.text
    check(typeof ptcOnly === 'string' && ptcOnly.includes('`run_code` is the only tool you can call directly'),
      'concise-ptc keeps the official direct-call collapse instruction')
    check(typeof sdk === 'string' && sdk.includes('Program-only SDK bindings:'),
      'concise-ptc keeps the generated PTC SDK section')
    for (const tool of EXPECTED_TOOLS) {
      check(typeof sdk === 'string' && sdk.includes('  ' + tool + ':'),
        'concise-ptc SDK declares ' + tool)
    }
    check(Array.isArray(value?.concisePtc?.systemPrompt?.contexts)
      && value.concisePtc.systemPrompt.contexts.length === 0,
      'concise-ptc system prompt contexts are exactly empty',
      'actual=' + JSON.stringify(value?.concisePtc?.systemPrompt?.contexts))

    if (failures !== 0) throw new Error(failures + ' concise-mode smoke assertion(s) failed')
    console.log('\nAll concise-mode checks passed.')
  } finally {
    try {
      await stopChildTree(child)
    } finally {
      rmSync(HOME, { recursive: true, force: true })
    }
  }
}

try {
  await main()
} catch (error) {
  console.error('\n[fail] ' + (error instanceof Error ? error.stack ?? error.message : String(error)))
  process.exitCode = 1
}
