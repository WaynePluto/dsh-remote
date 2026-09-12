import { isIP } from 'node:net'
import { z } from 'zod'
import { machineSlugSchema } from '@dsh-remote/protocol'
import { isLoopbackAddress } from './auth/loopback.js'
import { defaultDshRemoteHome } from './membership/paths.js'

const portSchema = z.number().int().min(0).max(65_535)
const bindHostSchema = z.string().refine(value => isIP(value) !== 0, 'host must be an IPv4 or IPv6 address')

/** 足够组成个人网状网络，同时足够小而能放在一个端口块内。 */
export const DEFAULT_MEMBER_PORT_COUNT = 64

/**
 * 每机器浏览器端口（D16 路由键 2）的起始位置。
 *
 * 未配置公网域名且主端口非 0 时默认使用紧邻主端口的端口块；公网子域名已有独立 origin，
 * 因此不自动绑定端口块，但显式配置起始端口仍可启用。
 * @param input 主端口、显式配置的起始端口和公网域名。
 * @returns 成员端口范围的第一个端口；禁用时返回 undefined。
 */
export function memberPortBaseFor(input: {
  port: number
  memberPortBase?: number | undefined
  publicDomain?: string | undefined
}): number | undefined {
  if (input.memberPortBase !== undefined) return input.memberPortBase
  if (input.publicDomain !== undefined) return undefined
  return input.port === 0 ? undefined : input.port + 1
}

const browserAuthConfigSchema = z.discriminatedUnion('cookieMode', [
  z.strictObject({ cookieMode: z.literal('lan-http') }),
  z.strictObject({ cookieMode: z.literal('domain-https') }),
])

const baseRelayConfigSchema = z.strictObject({
  host: bindHostSchema.default('127.0.0.1'),
  port: portSchema.default(30_809),
  /**
   * 这台机器的状态目录，与旁边运行的 connector 共享；
   * `membership.json` 会写在这里。允许覆盖，以便开发栈
   * 可以把状态放在 checkout 内，而不是用户真实 home。
   */
  home: z.string().min(1).default(() => defaultDshRemoteHome()),
  /** 生产环境/多机器路由：<slug>.<publicDomain>。 */
  publicDomain: z.string().min(1).transform(value => value.toLowerCase()).optional(),
  /** M1 单机器路由：IP/localhost Host 固定指向此 slug。 */
  directSlug: machineSlugSchema.optional(),
  /** 每成员端口范围的第一个端口；默认是主端口加一。 */
  memberPortBase: z.number().int().min(1).max(65_535).optional(),
  /** 端口范围包含多少个成员端口；0 表示完全禁用端口路由。 */
  memberPortCount: z.number().int().min(0).max(1_024).default(DEFAULT_MEMBER_PORT_COUNT),
  publicScheme: z.enum(['http', 'https']).default('https'),
  streamConnectTimeoutMs: z.number().int().positive().optional(),
  browserAuth: browserAuthConfigSchema.optional(),
})

export const relayConfigSchema = baseRelayConfigSchema.superRefine((value, context) => {
  if (value.publicDomain === undefined && value.directSlug === undefined) {
    context.addIssue({ code: 'custom', message: 'publicDomain or directSlug is required' })
  }
  if (value.browserAuth?.cookieMode === 'lan-http') {
    if (value.publicScheme !== 'http' || value.directSlug === undefined || value.publicDomain !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['browserAuth'],
        message: 'lan-http authentication requires publicScheme=http, directSlug, and no publicDomain',
      })
    }
  }
  if (value.browserAuth?.cookieMode === 'domain-https') {
    if (value.publicScheme !== 'https' || value.publicDomain === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['browserAuth'],
        message: 'domain-https authentication requires publicScheme=https and publicDomain',
      })
    }
  }
  const memberPortBase = memberPortBaseFor(value)
  if (memberPortBase !== undefined && value.memberPortCount > 0) {
    if (value.port >= memberPortBase && value.port < memberPortBase + value.memberPortCount) {
      context.addIssue({
        code: 'custom',
        path: ['memberPortBase'],
        message: 'member port range must not contain the relay main port',
      })
    }
    if (memberPortBase + value.memberPortCount - 1 > 65_535) {
      context.addIssue({
        code: 'custom',
        path: ['memberPortCount'],
        message: 'member port range must end at or below port 65535',
      })
    }
  }
  if (!isLoopbackAddress(value.host) && value.browserAuth?.cookieMode !== 'lan-http') {
    context.addIssue({
      code: 'custom',
      path: ['host'],
      message: 'non-loopback bind is allowed only with explicit lan-http browser authentication',
    })
  }
})

export type RelayConfig = z.output<typeof relayConfigSchema>
export type RelayConfigInput = z.input<typeof relayConfigSchema>

export function resolveRelayConfig(input: RelayConfigInput): RelayConfig {
  return relayConfigSchema.parse(input)
}
