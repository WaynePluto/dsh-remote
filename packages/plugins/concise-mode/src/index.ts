import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'

/** Preset root provider 的 Cordis 插件名。 */
export const name = 'dsh-remote-concise-preset-root'

/** 以 import.meta.url 定位内置 preset root，并以只读对象提供给 launcher。 */
export function apply(ctx: Context): void {
  const path = fileURLToPath(new URL('../presets/', import.meta.url))
  ctx.provide('dshRemoteConcisePresetRoot', Object.freeze({ path }))
}
