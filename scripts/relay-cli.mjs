/**
 * Run the relay CLI against the local development database.
 *
 * `node scripts/relay-cli.mjs <subcommand> [...args]` forwards everything to
 * `dsh-remote-relay`, filling in `.dev/relay.db` and the local secrets. In
 * production the same subcommands are available directly on the installed
 * `dsh-remote-relay` binary.
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
    // An explicit --data always wins; this only supplies the local default.
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
