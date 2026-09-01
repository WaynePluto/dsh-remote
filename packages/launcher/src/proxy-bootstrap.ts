/**
 * TEMPORARY: make the embedded dsh process honour conventional proxy variables.
 *
 * This module is preloaded into the dsh child with `node --import`. Node 22's
 * built-in fetch does not use HTTP_PROXY / HTTPS_PROXY by itself; installing an
 * Undici EnvHttpProxyAgent fixes development and M1 integration behind a
 * corporate proxy.
 *
 * Remove this file and the launcher preload when the dsh settings plugin in
 * docs/proxy-plugin-design.md is implemented. The plugin will be the sole
 * proxy configuration source and must not read process.env.
 */

import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici'

const LOCAL_BYPASS = ['localhost', '127.0.0.1', '::1'] as const

function firstDefined(env: NodeJS.ProcessEnv, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = env[name]?.trim()
    if (value !== undefined && value !== '') return value
  }
  return undefined
}

function noProxyWithLocalBypass(value: string | undefined): string {
  const entries = (value ?? '')
    .split(/[\s,]+/)
    .map(entry => entry.trim())
    .filter(entry => entry !== '')
  const seen = new Set(entries.map(entry => entry.toLowerCase()))
  for (const local of LOCAL_BYPASS) {
    if (!seen.has(local)) entries.push(local)
  }
  return entries.join(',')
}

/**
 * Install the temporary process-wide fetch proxy, if any proxy variable exists.
 * @returns the variable families in effect, or undefined when direct networking remains active.
 */
export function installEnvironmentProxy(
  env: NodeJS.ProcessEnv = process.env,
): { http: boolean; https: boolean; all: boolean } | undefined {
  const allProxy = firstDefined(env, 'ALL_PROXY', 'all_proxy')
  const httpProxy = firstDefined(env, 'HTTP_PROXY', 'http_proxy') ?? allProxy
  const httpsProxy = firstDefined(env, 'HTTPS_PROXY', 'https_proxy') ?? allProxy
  if (httpProxy === undefined && httpsProxy === undefined) return undefined

  const noProxy = noProxyWithLocalBypass(firstDefined(env, 'NO_PROXY', 'no_proxy'))
  setGlobalDispatcher(new EnvHttpProxyAgent({
    ...httpProxy === undefined ? {} : { httpProxy },
    ...httpsProxy === undefined ? {} : { httpsProxy },
    noProxy,
  }))

  return {
    http: firstDefined(env, 'HTTP_PROXY', 'http_proxy') !== undefined,
    https: firstDefined(env, 'HTTPS_PROXY', 'https_proxy') !== undefined,
    all: allProxy !== undefined,
  }
}

const active = installEnvironmentProxy()
if (active !== undefined) {
  const sources = [
    active.http ? 'HTTP_PROXY' : undefined,
    active.https ? 'HTTPS_PROXY' : undefined,
    active.all ? 'ALL_PROXY' : undefined,
  ].filter((source): source is string => source !== undefined)
  process.stderr.write(
    `[dsh-remote] temporary environment proxy enabled (${sources.join(', ')}); `
    + 'localhost/127.0.0.1/::1 always bypass it\n',
  )
}
