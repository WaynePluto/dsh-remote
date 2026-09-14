import type { Logger } from 'pino'
import type { MembershipLastHub, MembershipHub } from '@dsh-remote/protocol'
import { issueDeviceEnrollToken } from '../store/index.js'
import type { RelayStore } from '../store/store.js'
import { readMembershipFile, writeMembershipFile } from './file.js'
import { membershipFilePath } from './paths.js'

export interface SelfHubOptions {
  /** 这台机器自己的 slug，与 relay 的 `--direct-slug` 一致。 */
  readonly slug: string
  /** relay 主端口；自挂条目拨的就是它。 */
  readonly relayPort: number
}

/**
 * membership 中的 hub 是否是 relay 维护的本机自挂条目。
 *
 * 以 `selfManaged` 标记而不是地址推断：同一台机器上可以合法地跑两套
 * dsh-remote 做联调（一套加入另一套时 relayUrl 也是 loopback、slug 也
 * 相同），只有 relay 自己写入的标记才能无歧义地区分（见
 * `@dsh-remote/protocol` 的 membership schema）。
 * @param hub membership 记录的 hub。
 * @returns 是自挂条目时为 true。
 */
export function isSelfHub(hub: MembershipHub): boolean {
  return hub.selfManaged === true
}

/**
 * 构建这台机器的自挂 hub 条目。
 * @param options 这台机器自己的 slug 与 relay 主端口。
 * @param joinedAt 写入 membership 的时间戳。
 */
export function selfHub(options: SelfHubOptions, joinedAt: number): MembershipHub {
  const port = String(options.relayPort)
  return {
    relayUrl: `ws://127.0.0.1:${port}`,
    slug: options.slug,
    browserAuthority: `127.0.0.1:${port}`,
    selfManaged: true,
    joinedAt,
  }
}

export type SelfJoinOutcome
  = | { readonly kind: 'created' }
    | { readonly kind: 'refreshed' }
    | { readonly kind: 'kept' }
    | { readonly kind: 'unreadable' }

/**
 * 无条件写入自挂条目（附新签发的一次性注册令牌）。
 *
 * 供 {@link ensureSelfMembership} 与「取消远程入口」使用：取消后机器必须
 * 回到“只能从自己的地址打开”的状态，而这正需要自挂条目支撑。已存在的
 * lastHub 原样保留——它属于操作员的「重新连接」历史，不属于自挂条目。
 * @param options relay 的 store、dsh-remote home、本机 slug、主端口和 logger。
 * @returns 写入的时间戳；写入失败时抛出 `MembershipFileError`。
 */
export function writeSelfMembership(options: {
  readonly store: RelayStore
  readonly home: string
  readonly logger?: Logger | undefined
  readonly lastHub?: MembershipLastHub | undefined
} & SelfHubOptions): number {
  const now = Date.now()
  const { token } = issueDeviceEnrollToken({
    store: options.store,
    slug: options.slug,
    deviceName: 'self-joined by relay',
    via: 'self-join',
    now,
    ...options.logger === undefined ? {} : { logger: options.logger },
  })
  writeMembershipFile(
    membershipFilePath(options.home),
    {
      version: 1,
      hub: { ...selfHub(options, now), enrollToken: token },
      ...options.lastHub === undefined ? {} : { lastHub: options.lastHub },
    },
  )
  return now
}

/**
 * 确保这台机器挂在自己的 relay 上。
 *
 * relay 的 `directSlug` 路由（本机与局域网打开 dsh 的入口）也要经过
 * connector 控制信道，因此机器必须作为设备注册到自己的 relay。这里在
 * membership 中维护一个指向本机的条目：没有它，connector 会一直空等
 * “操作员加入 hub”，本机地址也就永远打不开（README 承诺的
 * `http://127.0.0.1:<port>/` 直达 dsh 的链路）。
 *
 * 规则：
 *   - 没有条目（首次运行或刚清空）→ 写入自挂条目并附一次性注册令牌；
 *   - 已是自挂条目（含端口或 slug 变化的旧条目）→ 刷新令牌重写；
 *   - 指向别的机器 → 原样保留，加入哪个 hub 仍由操作员在控制台决定；
 *   - 文件读不出 → 不动它：覆盖掉操作员可能还能修复的数据比缺失更糟。
 *
 * connector 消费掉令牌后会自行把它从文件中清除；relay 重启会再签发
 * 一个新令牌，未使用的旧令牌到期后由存储清理。
 * @param options relay 的 store、dsh-remote home、本机 slug、主端口和 logger。
 * @returns 做了什么；写入失败时抛出 `MembershipFileError`。
 */
export function ensureSelfMembership(options: {
  readonly store: RelayStore
  readonly home: string
  readonly logger?: Logger | undefined
} & SelfHubOptions): SelfJoinOutcome {
  const path = membershipFilePath(options.home)
  let membership: ReturnType<typeof readMembershipFile>
  try {
    membership = readMembershipFile(path)
  } catch (error) {
    options.logger?.error({ err: error, path }, 'could not read the membership file; leaving it alone')
    return { kind: 'unreadable' }
  }
  const hub = membership?.hub
  if (hub !== undefined && !isSelfHub(hub)) return { kind: 'kept' }

  writeSelfMembership({ ...options, ...membership?.lastHub === undefined ? {} : { lastHub: membership.lastHub } })
  options.logger?.info(
    { path, slug: options.slug, relayPort: options.relayPort },
    'self-joined this machine to its own relay so its own address can open dsh',
  )
  return hub === undefined ? { kind: 'created' } : { kind: 'refreshed' }
}
