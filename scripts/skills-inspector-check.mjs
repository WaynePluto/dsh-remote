/**
 * 冒烟：确认 skills-inspector 两半装上，「技能」tab 进入会话头部视图栏，通道能输出真实技能目录。
 * 真机契约：`conversation.view` 是 list 槽（已有 chat(0)/trajectory(10)/tools-inspector(20)，写错或变 keyed 会启动抛错）；`ctx.skills.snapshot()`/`get()` 签名也必须匹配。
 * `SkillSummary` 的 `list()` 投影没有 `path`，精确 `SKILL.md` 只能由 `skills.get()` 提供；来源桶（project-dsh/user-dsh/bundled …）是全局/项目级权威答案，枚举变化要被发现。
 * ⚠️ 只读观察窗口：不注册技能/工具，不 restrict/guard；任何副作用都违约。
 * 升级 dsh 后运行：`node scripts/skills-inspector-check.mjs [--port 3098]`。
 * 全过程不发模型请求、不写会话。
 */

import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DSH_BIN, DSH_PROFILE, DEV_DIRECTORY, ROOT, dshPluginOverlays } from './local-config.mjs'
import { createCheckContext, runLiveDshCheck } from './lib/check-context.mjs'
import {
  createClientInspectionContext,
  createHostInspectionContext,
  inspectClientBundle as inspectClientArtifact,
  inspectHostBundle as inspectHostArtifact,
  inspectionNoop,
} from './lib/check-client-bundle.mjs'


const PACKAGE_ID = '@dsh-remote/dsh-plugin-skills-inspector'
const portArgument = process.argv.indexOf('--port')
const PORT = portArgument === -1 ? 3098 : Number(process.argv[portArgument + 1])
const HOME = join(DEV_DIRECTORY, 'skills-inspector-check-home')
/** 宿主产物路径，两处都要用。 */
const HOST_ENTRY = join(ROOT, 'packages', 'plugins', 'skills-inspector', 'dist', 'index.js')

let failures = 0


function check(ok, what, detail) {
  if (!ok) failures += 1
  console.log(`${ok ? '[ok]  ' : '[fail]'} ${what}${detail === undefined ? '' : ` — ${detail}`}`)
}

const context = createCheckContext({
  dshBin: DSH_BIN,
  profile: DSH_PROFILE,
  overlays: dshPluginOverlays,
  home: HOME,
  cwd: ROOT,
  port: PORT,
  trustedHost: '127.0.0.1',
  packageId: PACKAGE_ID,
  channel: 'skills-inspector',
  tokenPattern: /token=([\w-]+)/u,
  timeoutMessage: (output) => 'dsh 60 秒内没有就绪。输出：\n' + output,
  exitMessage: (code, output) => 'dsh 退出，code ' + code + '。输出：\n' + output,
})
const { prepareHome } = context
/**
 * 检查 skills-inspector 宿主构建产物的通道与只读注册约束。
 *
 * 重点断言「什么都没注册」—— 这是只读观察窗口的定义。
 * @returns {Promise<{ channels: string[], events: string[], skills: number, tools: number, restricts: number, guards: number, disposers: number }>}
 */
async function inspectHostBundle() {
  const channels = []
  const events = []
  const disposers = []
  let skills = 0
  let tools = 0
  let restricts = 0
  let guards = 0
  const inspection = await inspectHostArtifact({
    entry: HOST_ENTRY,
    createContext: ({ cleanup }) => createHostInspectionContext({
      cleanup,
      channels,
      events,
      disposers,
      stubs: {
        skills: {
          register: () => { skills += 1; return inspectionNoop },
          registerProvider: () => { skills += 1; return inspectionNoop },
          snapshot: () => Promise.resolve({ skills: [], complete: true }),
          list: () => Promise.resolve([]),
          get: () => Promise.resolve(undefined),
        },
        tools: {
          register: () => { tools += 1; return inspectionNoop },
          restrict: () => { restricts += 1; return inspectionNoop },
          guard: () => { guards += 1; return inspectionNoop },
        },
      },
    }),
  })
  return { channels, events, skills, tools, restricts, guards, disposers: disposers.length, module: inspection.module }
}
/**
 * 用宿主产物的 `dispatch()` 走一遍完整投影：仿一个带会话日志的 agent，
 * 验它真的从两条加载路径里回放出了「已加载」。
 *
 * 这是本插件最核心也最容易错的地方：模型加载走 `tool/call`（name=skill，
 * 技能名藏在**原始参数串**里），用户加载走 `user/message`
 * （`source.kind === 'skill-invocation'`）。两条都得数对，失败的那次不能算。
 * @returns {Promise<{ snapshot: object, lookup: object }>} 快照与宿主实际用的 lookup。
 */
async function inspectProjection(module) {

  const events = [
    // 模型加载成功
    { type: 'tool/call', data: { callId: 'c1', name: 'skill', arguments: '{"name":"dsh-source"}' } },
    { type: 'tool/result', data: { message: { source: { callId: 'c1' } } } },
    // 模型加载失败 —— 正文从未进上下文，不能算「已加载」
    { type: 'tool/call', data: { callId: 'c2', name: 'skill', arguments: '{"name":"ghost"}' } },
    { type: 'tool/result', data: { message: { source: { callId: 'c2' } }, error: { code: 'X' } } },
    // 模型产出的畸形参数串 —— 绝不能让整个视图崩掉
    { type: 'tool/call', data: { callId: 'c3', name: 'skill', arguments: '{"name":' } },
    // 别的工具，与技能无关
    { type: 'tool/call', data: { callId: 'c4', name: 'read', arguments: '{"name":"git-commit"}' } },
    // 用户 /git-commit
    { type: 'user/message', data: { source: { kind: 'skill-invocation', name: 'git-commit' } } },
  ]
  const agent = { session: { header: { cwd: '/tmp/project' }, snapshotEvents: () => events } }
  let lookup = null
  const ctx = {
    agents: { get: () => agent },
    skills: {
      snapshot: (options) => {
        lookup = options
        return Promise.resolve({
          complete: true,
          skills: [
            {
              name: 'dsh-source',
              description: '定位并  查证\n\ndsh 源码',
              whenToUse: '需要确认 dsh 行为时',
              source: 'project-agents',
              provider: 'local',
              invocation: { modelInvocable: true, userInvocable: true },
              resourceBase: { kind: 'directory', path: '/tmp/project/.agents/skills/dsh-source' },
            },
            {
              name: 'git-commit',
              description: '创建规范 commit',
              source: 'user-dsh',
              provider: 'local',
              invocation: { modelInvocable: false, userInvocable: true },
              resourceBase: { kind: 'directory', path: '/home/me/.dsh/skills/git-commit' },
            },
            {
              name: 'ghost',
              description: '从未成功加载',
              source: 'bundled',
              provider: 'local',
              invocation: { modelInvocable: true, userInvocable: true },
            },
          ],
        })
      },
      get: () => Promise.resolve(undefined),
    },
  }
  const outcome = await module.dispatch(ctx, 'snapshot', { sessionId: 's1' })
  if (outcome.ok !== true) throw new Error(`dispatch 失败：${JSON.stringify(outcome)}`)
  return { snapshot: outcome.value, lookup }
}

/**
 * 检查 skills-inspector 浏览器构建产物的视图座位、命名空间和 external 依赖。
 *
 * @returns {{ seats: object[], namespaces: string[], externals: string[] }}
 */
function inspectClientBundle() {
  const bundle = join(ROOT, 'packages', 'plugins', 'skills-inspector', 'dist', 'client.js')
  return inspectClientArtifact({
    bundle,
    packageId: PACKAGE_ID,
    externalShims: new Map([
      ['react', { useState: inspectionNoop, useEffect: inspectionNoop, useCallback: inspectionNoop, useMemo: inspectionNoop, createElement: inspectionNoop }],
      ['react/jsx-runtime', { jsx: inspectionNoop, jsxs: inspectionNoop, Fragment: inspectionNoop }],
      ['@deepseek-ai/dsh-client-ui-primitives', { Button: inspectionNoop, Input: inspectionNoop, Tag: inspectionNoop }],
    ]),
    unknownExternal: (id) => new Error('bundle 要求页面模块表之外的模块：' + id),
    buildContext: ({ exports, externals }) => {
      const seats = []
      const namespaces = []
      const ctx = createClientInspectionContext({
        seats,
        namespaces,
        locale: { bind: () => (key => key) },
        fields: {
          remote: { session: { canOpenWorkspacePath: () => Promise.resolve({ ok: true, value: false }) } },
          get: () => undefined,
        },
      })
      exports.apply(ctx)
      return { seats, namespaces, externals: [...new Set(externals)] }
    },
  })
}
/**
 * 直接用真实 dsh 技能注册表验证本插件依赖的两条事实。
 * 不走 HTTP：技能 provider 位于 agent preset 的会话 scope，而脚本不创建会话，全局层本来为空；
 * 因此用指向本仓库 `.agents/skills` 的最小注册表与文件系统 provider。
 * `list()` 会投影掉 `path`（只留 `resourceBase`），`get()` 才返回精确的 `SKILL.md` 路径；
 * 这是「点击打开本地文件」的基础；dsh 改动会让页面静默显示「没有本地文件」，单元测试和 HTTP 冒烟也发现不了。
 * @returns {Promise<{ listed: object｜undefined, loadedPath: string｜undefined }}>
 */
async function verifySkillPath() {
  const paths = [join(ROOT, 'packages', 'launcher')]
  const { default: SkillRegistry } = await import(
    pathToFileURL(require_(paths, '@deepseek-ai/dsh-skill')).href)
  const filesystem = await import(
    pathToFileURL(require_(paths, '@deepseek-ai/dsh-skill-filesystem')).href)
  const { Context } = await import(pathToFileURL(require_(paths, '@deepseek-ai/cordis')).href)

  const ctx = new Context()
  ctx.plugin(SkillRegistry, {})
  // 只看本仓库的 .agents/skills，不去碰用户的全局技能目录。
  ctx.plugin(filesystem.default ?? filesystem, {
    skillDirs: [join(ROOT, '.agents', 'skills')],
    includeUserRoots: false,
  })
  await ctx.start?.()

  const lookup = { cwd: ROOT }
  const listed = (await ctx.skills.list(lookup)).find(skill => skill.name === 'dsh-source')
  const loaded = listed === undefined ? undefined : await ctx.skills.get('dsh-source', lookup)
  return { listed, loadedPath: loaded?.path }
}

/**
 * 从指定目录解析一个包的入口。
 * @param {string[]} paths 解析基准目录。
 * @param {string} id 包名。
 * @returns {string} 入口绝对路径。
 */
function require_(paths, id) {
  return createRequire(join(ROOT, 'package.json')).resolve(id, { paths })
}

async function main() {
  prepareHome()

  const artifact = await inspectHostBundle()
  check(artifact.channels.includes('/skills-inspector'), '宿主产物挂上了 /skills-inspector 通道',
    artifact.channels.join('、'))
  check(artifact.events.length === 0,
    '宿主产物不监听任何事件（「已加载」来自回放会话日志，重启后依然准确）',
    artifact.events.join('、') || '（没有）')
  check(artifact.disposers >= 1, '通道注册是可撤销的（挂在 ctx.effect 上）')
  // ⚠️ 这三条是本插件的定义性约束：它是只读观察窗口。
  check(artifact.skills === 0, '宿主产物没有注册任何技能或技能来源（不改变技能目录）',
    `实际 ${artifact.skills} 次`)
  check(artifact.tools === 0, '宿主产物没有注册任何工具', `实际 ${artifact.tools} 个`)
  check(artifact.restricts === 0 && artifact.guards === 0,
    '宿主产物没有调用 tools.restrict/guard（不改变 agent 能看到什么）',
    `restrict ${artifact.restricts}、guard ${artifact.guards}`)

  const { snapshot, lookup } = await inspectProjection(artifact.module)
  // ⚠️ 与 tools-inspector 同一个坑：scope 必须是 agent 本身，否则只读得到全局层。
  check(lookup?.scope !== undefined && lookup?.cwd === '/tmp/project',
    'skills 查询带上了 scope=agent 与 cwd（否则只读得到全局层）', JSON.stringify(Object.keys(lookup ?? {})))
  check(snapshot.total === 3 && snapshot.loaded === 2,
    '从两条加载路径回放出了「已加载」（模型 tool/call + 用户 skill-invocation）',
    JSON.stringify({ total: snapshot.total, loaded: snapshot.loaded }))

  const byName = Object.fromEntries(snapshot.entries.map(entry => [entry.name, entry]))
  check(byName['dsh-source']?.loaded?.by === 'model', '模型加载的那个被记成 model',
    JSON.stringify(byName['dsh-source']?.loaded))
  check(byName['git-commit']?.loaded?.by === 'user', '用户 /名字 加载的那个被记成 user',
    JSON.stringify(byName['git-commit']?.loaded))
  // 失败的加载不算：正文从未进入上下文。
  check(byName['ghost']?.loaded === undefined, '加载失败的技能不算「已加载」',
    JSON.stringify(byName['ghost']?.loaded))
  check(byName['dsh-source']?.description === '定位并 查证 dsh 源码',
    '描述里的换行与连续空白被折成单行', JSON.stringify(byName['dsh-source']?.description))
  check(byName['dsh-source']?.fullDescription === '定位并  查证\n\ndsh 源码',
    '展开区保留技能的完整原始描述', JSON.stringify(byName['dsh-source']?.fullDescription))
  check(byName['git-commit']?.modelInvocable === false,
    '「仅用户可调用」这一档被如实投影（disable-model-invocation 技能）')
  check(byName['dsh-source']?.directory === '/tmp/project/.agents/skills/dsh-source',
    '技能目录来自 resourceBase', String(byName['dsh-source']?.directory))
  // 来源桶就是「全局还是项目级」的答案，不该被我们改写。
  const sources = [...new Set(snapshot.entries.map(entry => entry.source))].sort()
  check(sources.join(',') === 'bundled,project-agents,user-dsh',
    '来源桶原样透传（全局 / 项目级的权威答案）', sources.join('、'))

  const client = inspectClientBundle()
  check(client.seats.length === 1, '浏览器产物只占一个座位', `共 ${client.seats.length} 个`)
  const seat = client.seats[0]
  // `conversation.view` 是 list 槽，dsh 自己的 chat(0)、trajectory(10) 已经在里面。
  check(seat?.name === 'conversation.view', '座位是会话头部那个视图切换栏的 list 槽', String(seat?.name))
  check(seat?.id === 'dsh-plugin-skills-inspector', '条目 id 用的是包名后缀', String(seat?.id))
  check(typeof seat?.order === 'number' && seat.order > 20,
    'order 排在 chat(0)、trajectory(10) 与「工具」(20) 之后', String(seat?.order))
  // ⚠️ label 必须是 thunk，否则切换语言后 tab 文字不跟着变。
  check(typeof seat?.label === 'function', 'tab 文案是 thunk，跟随语言切换', typeof seat?.label)
  check(client.namespaces.includes('dsh-plugin-skills-inspector'), '文案命名空间也是包名后缀',
    client.namespaces.join('、'))
  const PLATFORM_MODULES = [
    'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
    '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-slots',
    '@deepseek-ai/dsh-client-ui-primitives',
  ]
  const offTable = client.externals.filter(id => !PLATFORM_MODULES.includes(id))
  check(offTable.length === 0, '浏览器产物只 require 页面模块表里的说明符',
    offTable.length === 0 ? client.externals.join('、') : `表外：${offTable.join('、')}`)

  // ⚠️ 「点击打开本地文件」的地基，对着真注册表验（见 verifySkillPath 的注释）。
  try {
    const { listed, loadedPath } = await verifySkillPath()
    check(listed !== undefined, '真注册表里读到了本仓库的 dsh-source 技能')
    check(listed !== undefined && listed.path === undefined,
      'list() 的 SkillSummary 上没有 path（所以列表不能显示精确文件，必须单独 locate）',
      String(listed?.path))
    check(listed?.resourceBase?.kind === 'directory' && typeof listed.resourceBase.path === 'string',
      'list() 只给到技能目录 resourceBase', JSON.stringify(listed?.resourceBase))
    check(typeof loadedPath === 'string' && loadedPath.endsWith('SKILL.md'),
      'get() 给出了精确的 SKILL.md 路径（「点击打开本地文件」靠这条）', String(loadedPath))
  } catch (error) {
    check(false, '真技能注册表可用于验证 path 链路', String(error?.message ?? error))
  }

  await runLiveDshCheck(context, {
    startedAssertions: () => {
      check(true, 'dsh 带全部 --patch 正常启动（槽注册与通道挂载都被接受）')
    },
    exchangeAssertions: ({ exchange, cookie }) => {
      check(cookie !== '', 'token 换到了 dsh 的浏览器 cookie', `status ${exchange.status}`)
    },
    bundleAssertions: ({ index, url, bundle, bundleBody }) => {
      const idAt = index.indexOf(`"id":"${PACKAGE_ID}"`)
      check(idAt !== -1, '首页的 __DSH_BOOT__ 里有本插件的行')

      if (url !== null) {
        check(bundle.ok, '插件 bundle 能取到', `status ${bundle.status}`)
        check(bundleBody.includes('__ModuleLoader__.load'), 'bundle 是加载器认识的工件格式')
        check(bundleBody.includes('conversation.view'), 'bundle 里带着视图切换栏的槽注册')
        check(bundleBody.includes('/skills-inspector'), 'bundle 里带着宿主那条私有通道的路径')
        check(bundleBody.includes('visibilitychange'), 'bundle 里带着「页面不可见就停止轮询」的那半逻辑')
        check(bundleBody.includes('canOpenWorkspacePath'),
          'bundle 里带着「本机能否打开」的能力探测（远程页面上按钮应当隐藏）')
      }
    },
    liveAssertions: async ({ cookie }) => {
      const live = await context.callChannel('snapshot', { sessionId: 'no-such-session' }, cookie)
      const value = live.body?.result?.value
      check(live.status === 200 && live.body?.result?.ok === true && Array.isArray(value?.entries),
        '/skills-inspector 通道已挂载，且对没有活 agent 的会话退回全局视图',
        JSON.stringify(live.body).slice(0, 200))
      check(typeof value?.complete === 'boolean',
        '快照带着「技能目录是否完整」（有 provider 失败时页面要如实说明）',
        String(value?.complete))
      const allowed = [
        'name', 'description', 'fullDescription', 'whenToUse', 'source', 'provider', 'directory',
        'modelInvocable', 'userInvocable', 'loaded',
      ]
      const extra = value?.entries?.flatMap(entry =>
        Object.keys(entry).filter(key => !allowed.includes(key))) ?? []
      check(extra.length === 0, '条目形状没有多出未预期的字段', extra.join('、'))

      const missing = await context.callChannel('locate', { sessionId: 'no-such-session', name: 'definitely-not-a-skill' }, cookie)
      check(missing.body?.result?.ok === true && missing.body.result.value?.path === undefined,
        'locate 对查不到的技能返回「没有路径」而不是抛错',
        JSON.stringify(missing.body).slice(0, 200))

      const malformed = await context.callChannel('snapshot', {}, cookie)
      check(
        malformed.body?.result?.ok === false
        && malformed.body.result.error?.code === 'skills-inspector/bad-payload',
        '缺少 sessionId 的调用被通道自己挡下',
        JSON.stringify(malformed.body),
      )

      const noName = await context.callChannel('locate', { sessionId: 'x' }, cookie)
      check(
        noName.body?.result?.ok === false
        && noName.body.result.error?.code === 'skills-inspector/bad-payload',
        '缺少技能名的 locate 被挡下',
        JSON.stringify(noName.body),
      )

      const unknown = await context.callChannel('reset', { sessionId: 'x' }, cookie)
      check(
        unknown.body?.result?.ok === false
        && unknown.body.result.error?.code === 'skills-inspector/unknown-endpoint',
        '通道上只有 snapshot / locate 两个端点（观察窗口没有写操作）',
        JSON.stringify(unknown.body),
      )

      const unauthenticated = await fetch(`${context.base}/skills-inspector/snapshot`, {
        method: 'POST',
        headers: { host: context.authority, 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: 'smoke', method: 'snapshot', payload: { sessionId: 'x' } }),
      })
      check(unauthenticated.status === 401, '没有 cookie 的调用被 dsh 挡在门外', `status ${unauthenticated.status}`)
    },
  })
  console.log(failures === 0 ? '\n全部通过。' : `\n${failures} 项未通过。`)
  process.exit(failures === 0 ? 0 : 1)
}

await main()
