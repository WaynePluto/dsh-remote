import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * 返回冒烟使用的默认 dsh home。
 * 未显式设置 DSH_HOME 时回退到用户 home；调用脚本应把 `home` 指向隔离目录。
 */
export function defaultDshHome() {
  return process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
}

/**
 * 清理一个冒烟 home，调用方可在准备前后重复调用。
 * 目标目录递归删除且不存在时不报错，适合放在检查的开始与 finally 中。
 */
export function cleanupCheckHome(home) {
  rmSync(home, { recursive: true, force: true })
}

/**
 * 复制真实 profile 到隔离的冒烟 home。
 * 先清空目标，再从 sourceHome/profiles/profile 复制；缺失 profile 交给调用方的回调处理。
 * 隔离 home 避免冒烟写入用户 DSH_HOME 或正在运行的会话。
 */
export function prepareCheckHome({ home, profile, sourceHome = defaultDshHome(), onMissingProfile }) {
  cleanupCheckHome(home)
  const source = join(sourceHome, 'profiles', profile)
  if (!existsSync(source)) {
    if (onMissingProfile !== undefined) return onMissingProfile(source)
    throw new Error(`找不到 profile ${source}`)
  }
  mkdirSync(join(home, 'profiles'), { recursive: true })
  cpSync(source, join(home, 'profiles', profile), { recursive: true })
  return { home, profile, source }
}

/**
 * 在冒烟 home 生命周期内运行检查，并保证临时目录最终被删除。
 * prepare 在 run 前准备 profile，finally 删除 home；run 的其他临时资源由调用方自行管理。
 */
export async function withCheckHome({ home, prepare }, run) {
  try {
    const prepared = prepare()
    return await run(prepared)
  } finally {
    cleanupCheckHome(home)
  }
}
