/**
 * launcher 与 relay 之间的本地交接契约：launcher 自动重启 dsh 的进度。
 *
 * membership 变更改变 dsh 必须信任的地址集合时，launcher 会自动重启 dsh，
 * 并在重启前后把进度写入此文件；本机控制台的「远程入口」页读取它向操作员
 * 解释加入或取消远程入口之后机器上正在发生什么。这不是隧道线路协议的一部分；
 * 与 membership.json 一样属于两侧必须共享的本地契约，重复 schema 会让页面
 * 悄然偏离实际状态。
 */

import { z } from 'zod'

/** dsh-remote home 目录下使用的文件名。 */
export const DSH_RESTART_STATUS_FILE_NAME = 'dsh-restart-status.json'

/** 与 membership 的 browserAuthority 相同的形态：裸 `host` 或 `host:port`。 */
const authoritySchema = z.string().min(1).max(255)

export const dshRestartStatusSchema = z.strictObject({
  /** 重启进行中、已完成或已失败。 */
  state: z.enum(['restarting', 'done', 'failed']),
  /** 本次状态写入的 unix 毫秒时间戳。 */
  at: z.number().int().nonnegative(),
  /** 本次重启新信任的浏览器 authority。 */
  added: z.array(authoritySchema),
  /** 本次重启不再信任的浏览器 authority。 */
  removed: z.array(authoritySchema),
  /** state 为 failed 时的失败原因。 */
  error: z.string().min(1).max(4096).optional(),
})

export type DshRestartStatus = z.infer<typeof dshRestartStatusSchema>

/**
 * 解析状态文件内容。
 * @param raw - 文件文本。
 * @returns 解析后的状态；文件为空（例如从未重启过）时为 undefined。
 */
export function parseDshRestartStatus(raw: string | undefined): DshRestartStatus | undefined {
  if (raw === undefined || raw.trim() === '') return undefined
  return dshRestartStatusSchema.parse(JSON.parse(raw))
}

/**
 * @param status - 要持久化的状态。
 * @returns 末尾带换行符的文件内容。
 */
export function serializeDshRestartStatus(status: DshRestartStatus): string {
  return `${JSON.stringify(dshRestartStatusSchema.parse(status), undefined, 2)}\n`
}
