import { isIP } from 'node:net'
import { z } from 'zod'
import { machineSlugSchema } from '@dsh-remote/protocol'
import { isLoopbackAddress } from './auth/loopback.js'
import { defaultDshRemoteHome } from './membership/paths.js'

const portSchema = z.number().int().min(0).max(65_535)
const bindHostSchema = z.string().refine(value => isIP(value) !== 0, 'host must be an IPv4 or IPv6 address')

/** Enough machines for a personal mesh, small enough to stay inside one block. */
export const DEFAULT_MEMBER_PORT_COUNT = 64

/**
 * Where the per-machine browser ports (D16 routing key 2) start.
 *
 * The default block sits directly above the main port so a LAN hub needs no
 * extra configuration and the operator can predict the range. It is derived
 * only where the routing key is actually needed: a subdomain deployment already
 * gives every machine its own origin, and a relay that sits behind a reverse
 * proxy must not quietly bind a block of extra ports. Both that case and an
 * ephemeral main port can still opt in by configuring a base explicitly.
 * @param input The main port, an explicitly configured base, and the public
 * domain when one is deployed.
 * @returns The first port of the member range, or undefined when disabled.
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
   * State directory of this machine, shared with the connector running beside
   * it; `membership.json` is written here. Overridable so a development stack
   * can keep its state inside the checkout instead of the real user home.
   */
  home: z.string().min(1).default(() => defaultDshRemoteHome()),
  /** Production/multi-machine route: <slug>.<publicDomain>. */
  publicDomain: z.string().min(1).transform(value => value.toLowerCase()).optional(),
  /** M1 single-machine route: an IP/localhost Host is pinned to this slug. */
  directSlug: machineSlugSchema.optional(),
  /** First port of the per-member range; defaults to the main port plus one. */
  memberPortBase: z.number().int().min(1).max(65_535).optional(),
  /** How many member ports the range spans; 0 disables port routing entirely. */
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
