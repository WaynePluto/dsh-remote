import { strict as assert } from 'node:assert'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { browserHeaders, findClientBundleUrl, responseCookie } from './check-http.mjs'
import { createClientInspectionContext, createHostInspectionContext, inspectClientBundle, inspectHostBundle, inspectionNoop, loadClientBundle } from './check-client-bundle.mjs'
import { createCheckContext, runLiveDshCheck } from './check-context.mjs'

const base = 'http://127.0.0.1:3099'
assert.deepEqual(browserHeaders({ authority: '127.0.0.1:3099', base }), {
  host: '127.0.0.1:3099',
  origin: base,
  'sec-fetch-site': 'same-origin',
})
assert.equal(browserHeaders({ authority: '127.0.0.1:3099', base, cookie: 'dsh=smoke' }).cookie, 'dsh=smoke')
assert.equal(responseCookie({ headers: { getSetCookie: () => ['dsh=one; Path=/', 'other=two; HttpOnly'] } }), 'dsh=one; other=two')
assert.equal(findClientBundleUrl('<script>{"id":"pkg","url":"/client.js"}</script>', 'pkg'), '/client.js')
assert.equal(findClientBundleUrl('<script>{"id":"other","url":"/client.js"}</script>', 'pkg'), null)

const directory = mkdtempSync(join(tmpdir(), 'dsh-remote-helper-'))
const sourceHome = join(directory, 'source')
const contextHome = join(directory, 'context-home')
mkdirSync(join(sourceHome, 'profiles', 'smoke-profile'), { recursive: true })
writeFileSync(join(sourceHome, 'profiles', 'smoke-profile', 'package.json'), '{}')
const context = createCheckContext({
  dshBin: 'dsh',
  profile: 'smoke-profile',
  overlays: [],
  home: contextHome,
  sourceHome,
  cwd: directory,
  port: 3012,
  trustedHost: '127.0.0.1',
  packageId: 'smoke-package',
  channel: 'smoke',
  cleanup: false,
})
assert.equal(context.authority, '127.0.0.1:3012')
assert.equal(context.base, 'http://127.0.0.1:3012')
assert.deepEqual(context.browserHeaders(), {
  host: '127.0.0.1:3012',
  origin: 'http://127.0.0.1:3012',
  'sec-fetch-site': 'same-origin',
})
context.prepareHome()
assert.equal(existsSync(join(contextHome, 'profiles', 'smoke-profile', 'package.json')), true)
assert.equal(context.findClientBundleUrl('<script>{"id":"smoke-package","url":"/client.js"}</script>'), '/client.js')
assert.equal(typeof context.callChannel, 'function')
const hostChannels = []
const hostEvents = []
const hostDisposers = []
const hostCleanups = []
const hostShim = createHostInspectionContext({
  cleanup: (disposer) => { hostCleanups.push(disposer) },
  channels: hostChannels,
  events: hostEvents,
  disposers: hostDisposers,
  stubs: { skills: { snapshot: () => [] } },
  fields: { marker: true },
})
const hostDisposer = () => {}
hostShim.connection.rpc.handle('/helper')
hostShim.on('helper/event')
hostShim.effect(() => hostDisposer)
assert.deepEqual(hostChannels, ['/helper'])
assert.deepEqual(hostEvents, ['helper/event'])
assert.deepEqual(hostDisposers, [hostDisposer])
assert.deepEqual(hostCleanups, [hostDisposer])
assert.deepEqual(hostShim.skills.snapshot(), [])
assert.equal(hostShim.marker, true)
assert.equal(hostShim.get('unknown'), undefined)
const hostWithoutEvents = createHostInspectionContext({ cleanup: () => {} })
assert.equal('on' in hostWithoutEvents, false)

const clientSeats = []
const clientNamespaces = []
const clientDisposers = []
let injected = false
const client = createClientInspectionContext({
  seats: clientSeats,
  namespaces: clientNamespaces,
  disposers: clientDisposers,
  locale: { bind: () => (key) => key },
  fields: { remote: { session: {} }, get: () => undefined },
})
const clientDisposer = () => {}
client.effect(() => clientDisposer)
client.locale.register('helper')
client.slots.inject('helper-slot', () => { injected = true })
client.slots.register({ name: 'helper.slot' })
assert.deepEqual(clientDisposers, [clientDisposer])
assert.deepEqual(clientNamespaces, ['helper'])
assert.deepEqual(clientSeats, [{ name: 'helper.slot' }])
assert.equal(injected, true)
assert.equal(client.locale.bind()('key'), 'key')
assert.equal(client.remote.session !== undefined, true)
assert.equal(client.slots.unknown, undefined)
assert.equal(inspectionNoop(), undefined)

const liveOrder = []
const originalFetch = globalThis.fetch
globalThis.fetch = async (url, options) => {
  liveOrder.push(`fetch:${url}`)
  assert.equal(options.headers.cookie, 'dsh=live')
  return { text: async () => '<script>{"id":"smoke-package","url":"/client.js"}</script>' }
}
const liveContext = {
  ...context,
  startDsh: async () => {
    liveOrder.push('start')
    return { child: { id: 'live-child' }, token: 'live-token' }
  },
  stopDsh: async (child) => {
    assert.equal(child.id, 'live-child')
    liveOrder.push('stop')
  },
  exchangeToken: async (token) => {
    liveOrder.push(`exchange:${token}`)
    return { response: { status: 303 }, cookie: 'dsh=live' }
  },
  fetchClientBundle: async (url, cookie) => {
    assert.equal(url, '/client.js')
    assert.equal(cookie, 'dsh=live')
    liveOrder.push('bundle-fetch')
    return { ok: true, status: 200, text: async () => 'client bundle' }
  },
}
try {
  const live = await runLiveDshCheck(liveContext, {
    startedAssertions: ({ token }) => { liveOrder.push(`started:${token}`) },
    exchangeAssertions: ({ cookie, exchange }) => {
      liveOrder.push(`exchanged:${cookie}`)
      assert.equal(exchange.status, 303)
    },
    bundleAssertions: ({ url, bundleBody }) => {
      assert.equal(url, '/client.js')
      assert.equal(bundleBody, 'client bundle')
      liveOrder.push('bundle-assertions')
    },
    liveAssertions: ({ cookie, index }) => {
      assert.equal(cookie, 'dsh=live')
      assert.match(index, /smoke-package/u)
      liveOrder.push('live-assertions')
    },
  })
  assert.equal(live.token, 'live-token')
  assert.deepEqual(liveOrder, [
    'start', 'started:live-token', 'exchange:live-token', 'exchanged:dsh=live',
    'fetch:http://127.0.0.1:3012/', 'bundle-fetch', 'bundle-assertions', 'live-assertions', 'stop',
  ])

  await assert.rejects(
    runLiveDshCheck(liveContext, { liveAssertions: () => { throw new Error('live assertion failed') } }),
    /live assertion failed/u,
  )
  assert.equal(liveOrder.at(-1), 'stop')
} finally {
  globalThis.fetch = originalFetch
}

const bundle = join(directory, 'client.js')
writeFileSync(bundle, [
  'window.__ModuleLoader__.load({',
  '  id: "smoke-package",',
  '  factory: (require) => ({ answer: require("react").answer }),',
  '})',
].join('\n'))
const host = join(directory, 'host.mjs')
writeFileSync(host, [
  'export function apply(ctx, options) {',
  '  ctx.value = options.value',
  '  ctx.effect(() => () => { ctx.cleaned = true })',
  '}',
].join('\n'))
try {
  const report = loadClientBundle({
    bundle,
    packageId: 'smoke-package',
    externalShims: new Map([['react', { answer: 42 }]]),
  })
  assert.equal(report.exports.answer, 42)
  assert.deepEqual(report.externals, ['react'])
  const inspected = inspectClientBundle({
    bundle,
    packageId: 'smoke-package',
    externalShims: new Map([['react', { answer: 42 }]]),
    buildContext: ({ source, exports, externals }) => ({
      answer: exports.answer,
      source,
      externals,
    }),
  })
  assert.equal(inspected.answer, 42)
  assert.equal(inspected.source.includes('__ModuleLoader__.load'), true)
  assert.deepEqual(inspected.externals, ['react'])
  assert.throws(() => inspectClientBundle({
    bundle,
    packageId: 'smoke-package',
    externalShims: new Map(),
    buildContext: () => undefined,
  }), /bundle 要求页面模块表之外的模块：react/)
  const hostInspection = await inspectHostBundle({
    entry: host,
    applyArgs: [{ value: 42 }],
    createContext: ({ cleanup }) => {
      const hostContext = {
        value: 0,
        cleaned: false,
        effect: (run) => {
          const dispose = run()
          cleanup(dispose)
          return () => {}
        },
      }
      return hostContext
    },
  })
  assert.equal(hostInspection.context.value, 42)
  assert.equal(hostInspection.context.cleaned, true)
  assert.equal(hostInspection.errors.length, 0)
  assert.equal(hostInspection.cleanups.length, 1)
} finally {
  rmSync(directory, { recursive: true, force: true })
}

console.log('冒烟公共 helper 自检通过。')
