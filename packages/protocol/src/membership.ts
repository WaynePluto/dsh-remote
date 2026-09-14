/**
 * 同一台机器上 relay 与 connector 之间的本地交接契约。
 * 加入 hub 由 relay 管理控制台决定、由独立进程 connector 执行；控制台写入此文件，connector 读取它，文件也作为跨重启持久化载体。
 * 这不是隧道线路协议的一部分；两个包必须逐字节共享此契约，重复 schema 才会让两侧悄然产生偏差。
 */

import { z } from 'zod'
import { machineSlugSchema } from './frames.js'

/** 只接受 `ws:`/`wss:`：connector 拨号连接 relay，从不 fetch relay。 */
const relayUrlSchema = z.url().refine(
  value => value.startsWith('ws://') || value.startsWith('wss://'),
  'relay URL must use ws:// or wss://',
)

export const membershipSchema = z.strictObject({
  version: z.literal(1),
  /** 这台机器加入的 hub。一台机器最多加入一个 hub（D16）。 */
  hub: z.strictObject({
    relayUrl: relayUrlSchema,
    /** 这台机器在该 hub 上声明的 slug。 */
    slug: machineSlugSchema,
    /**
     * 一次性注册令牌，仅在 hub 接受之前存在。
     * connector 在注册成功后清除它，使已使用的密钥
     * 不会永远留在磁盘上。
     */
    enrollToken: z.string().min(16).max(4096).optional(),
    /**
     * hub 面向浏览器的 authority，例如 `10.1.2.87:30810`。
     *
     * Mode A 原样转发浏览器的 Host，因此这台机器上的 dsh 必须
     * 信任 hub 的 authority。记录在这里后 launcher 就能传入
     * `--trusted-host`，无需用户重新输入。
     */
    browserAuthority: z.string().min(1).max(255).optional(),
    /**
     * relay 维护的本机自挂条目（见 relay 的 `membership/self-join.ts`）：
     * 它让本机与局域网地址能直达这台机器的 dsh，不是操作员设置的远程入口。
     * 只有 relay 会写这个标记；控制台的加入表单不携带它。
     */
    selfManaged: z.literal(true).optional(),
    joinedAt: z.number().int().nonnegative(),
  }).optional(),
  /**
   * 上次使用的远程入口。「取消远程入口」时由 relay 把当时的 hub（去掉
   * 已用的一次性令牌）保存到这里，控制台据此提供一键「重新连接」；
   * 重新连接或设置新入口都会清掉它。它不是秘密——设备密钥仍在两侧，
   * hub 还认识这台机器时，恢复 hub 条目即可直接认证。
   */
  lastHub: z.strictObject({
    relayUrl: relayUrlSchema,
    slug: machineSlugSchema,
    browserAuthority: z.string().min(1).max(255).optional(),
    /** 该 hub 当初被加入的时间；随条目一起保留用于展示。 */
    joinedAt: z.number().int().nonnegative(),
  }).optional(),
})

export type Membership = z.infer<typeof membershipSchema>
export type MembershipHub = NonNullable<Membership['hub']>
export type MembershipLastHub = NonNullable<Membership['lastHub']>

/**
 * 把一个 hub 条目转成可保存的 lastHub：去掉一次性注册令牌与自挂标记。
 * @param hub 要保留的 hub 条目。
 * @returns 只含地址身份与时间的 lastHub。
 */
export function lastHubFromHub(hub: MembershipHub): MembershipLastHub {
  return {
    relayUrl: hub.relayUrl,
    slug: hub.slug,
    ...hub.browserAuthority === undefined ? {} : { browserAuthority: hub.browserAuthority },
    joinedAt: hub.joinedAt,
  }
}

/** dsh-remote home 目录下使用的文件名。 */
export const MEMBERSHIP_FILE_NAME = 'membership.json'

/**
 * 解析 membership 文件内容。
 * @param raw - 文件文本；文件不存在时为 undefined。
 * @returns 解析后的 membership；这台机器尚未加入
 * hub 时为 undefined。文件格式错误时抛出异常，而不是静默重置 membership。
 */
export function parseMembership(raw: string | undefined): Membership | undefined {
  if (raw === undefined || raw.trim() === '') return undefined
  return membershipSchema.parse(JSON.parse(raw))
}

/**
 * @param membership - 要持久化的 membership。
 * @returns 末尾带换行符的文件内容。
 */
export function serializeMembership(membership: Membership): string {
  return `${JSON.stringify(membership, undefined, 2)}\n`
}
