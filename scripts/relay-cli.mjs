/**
 * 使用本地开发数据库运行 relay CLI。
 *
 * `node scripts/relay-cli.mjs <subcommand> [...args]` 将所有内容转发给
 * `dsh-remote-relay`，并填入 `.dev/relay.db` 与本地密钥。生产环境中相同的
 * 子命令也可以直接通过已安装的 `dsh-remote-relay` 可执行文件使用。
 */

import { spawnSync } from 'node:child_process'
import process from 'node:process'
import {
  RELAY_DATABASE,
  ROOT,
  localSecrets,
  relayCliArguments,
  relayEnvironment,
} from './local-config.mjs'

const forwarded = process.argv.slice(2).filter(argument => argument !== '--built')
const built = process.argv.includes('--built')
if (forwarded.length === 0) {
  console.error('用法: node scripts/relay-cli.mjs <init|passwd|totp reset> [...参数]')
  process.exit(1)
}

const result = spawnSync(
  process.execPath,
  [
    ...relayCliArguments(built),
    ...forwarded,
    // 显式提供的 --data 始终优先；这里只提供本地默认值。
    ...forwarded.includes('--data') ? [] : ['--data', RELAY_DATABASE],
  ],
  {
    cwd: ROOT,
    env: relayEnvironment(localSecrets()),
    stdio: 'inherit',
  },
)

if (result.error !== undefined) throw result.error
process.exitCode = result.status ?? 1
