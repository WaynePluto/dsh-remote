import { networkInterfaces } from 'node:os'
import { LauncherError } from './errors.js'

/** 始终可以从机器自身访问。 */
export const LOOPBACK_TRUSTED_HOSTS = ['127.0.0.1', 'localhost'] as const

/**
 * dsh 计算出的 authority 规范形式。
 *
 * 端口会在两个特殊 scheme 下解析，因此 `:80` 和 `:443`
 * 仍算作显式写出；这与
 * `@deepseek-ai/dsh-client-connection` 中的 `canonicalAuthority` 一致。
 */
function canonicalAuthority(entry: string): string | undefined {
  let url: URL
  try {
    url = new URL(`http://${entry}`)
  } catch {
    return undefined
  }
  let port = url.port
  if (port === '') {
    try {
      port = new URL(`https://${entry}`).port
    } catch {
      return undefined
    }
  }
  return port === '' ? url.hostname : `${url.hostname}:${port}`
}

/**
 * dsh 是否会接受这个字符串作为 `--trusted-host` 条目。
 * 规则来自 dsh 自己的 `assertTrustedAuthority`（位于 `@deepseek-ai/dsh-client-connection`）：接受能在除大小写外保持不变地通过 URL 解析的裸 `host` 或 `host:port`，其他内容会在加载插件树时失败。
 * @param entry - 原样提供的候选 authority。
 * @returns dsh 会接受它时为 true。
 */
export function isBareAuthority(entry: string): boolean {
  const canonical = canonicalAuthority(entry)
  return canonical !== undefined && canonical === entry.toLowerCase()
}

/** 被拒绝的 authority 来源，使消息能说明修复方式。 */
export interface TrustedHostSource {
  readonly value: string
  /** 可读的来源，例如 `membership.json 里入口机器的浏览器地址`。 */
  readonly origin: string
}

/**
 * @param entries - 带来源的候选 authority。
 * @throws LauncherError 任一条目不是裸 `host[:port]` 时抛出。
 */
export function assertTrustedHosts(entries: readonly TrustedHostSource[]): void {
  for (const entry of entries) {
    if (isBareAuthority(entry.value)) continue
    throw new LauncherError(
      `${entry.origin} "${entry.value}" 不是一个裸地址，dsh 不接受它。`,
      { hint: '只能写 主机名 或 主机名:端口，例如 10.1.2.87:30810；不要带 http:// 、路径或结尾的冒号。' },
    )
  }
}

/**
 * 这台机器的第一个非内部 IPv4 地址。
 *
 * 跳过 APIPA 地址：未能获得租约的接口永远不是
 * 局域网手机会输入的地址。
 * @returns 地址；这台机器未联网时为 undefined。
 */
export function lanAddress(): string | undefined {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family !== 'IPv4' || address.internal) continue
      if (address.address.startsWith('169.254.')) continue
      return address.address
    }
  }
  return undefined
}

/**
 * 浏览器可能放进到达这台机器 dsh 的请求 `Host` header 中的每个 authority。
 * Mode A 原样转发 Host（铁律 7），因此 dsh 必须信任所有这些 authority，否则请求会得到 403；没有端口的条目匹配任意端口。
 * @param options - 局域网地址和 hub 面向浏览器的 authority，二者都可选；尚未加入 hub 的机器只能在本地访问。
 * @returns 去重且顺序稳定的 `--trusted-host` 列表。
 * @throws LauncherError 条目不是裸 `host[:port]` 时抛出。
 */
export function trustedHostsFor(options: {
  readonly lanAddress?: string | undefined
  readonly hubAuthority?: string | undefined
}): readonly string[] {
  const sources: TrustedHostSource[] = [
    ...LOOPBACK_TRUSTED_HOSTS.map(value => ({ value, origin: '本机地址' })),
    ...options.lanAddress === undefined ? [] : [{ value: options.lanAddress, origin: '本机局域网地址' }],
    ...options.hubAuthority === undefined
      ? []
      : [{ value: options.hubAuthority, origin: 'membership.json 里入口机器的浏览器地址' }],
  ]
  assertTrustedHosts(sources)
  const seen = new Set<string>()
  const hosts: string[] = []
  for (const source of sources) {
    const key = source.value.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    hosts.push(source.value)
  }
  return hosts
}

