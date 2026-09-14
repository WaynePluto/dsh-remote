/** 安全与权限契约：此处说明固定权限、审批边界及异常回退。（涉及：`ctx.terminals.startSend`、`Read-Host`、`read`、`dsh-subprocess-local`、`dsh-sandbox-policy`、`dsh-session-projection`、`dsh-terminal`、`dsh-terminal-bash`） */

import { Context } from '@deepseek-ai/cordis'
import TerminalSessionService from '@deepseek-ai/dsh-terminal'
import * as terminalBash from '@deepseek-ai/dsh-terminal-bash'
import sandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import sessionProjection from '@deepseek-ai/dsh-session-projection'
import subprocessLocal from '@deepseek-ai/dsh-subprocess-local'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Config, backendConfig, sendToTerminal, snapshot } from '../src/index.js'

/** 进程与运行时契约：此处说明生命周期、身份核验、轮询或终端边界。 */
/* oxlint-disable no-await-in-loop -- live smoke 逐项验证通道端点，顺序本身是验收契约。 */
const TIMEOUT_MS = 90_000

/** 测试契约：此处说明本测试锁定的行为和回归边界。（涉及：`apply`） */
function resolved(overrides: Record<string, unknown> = {}): Config {
  return new (Config as unknown as new (value: unknown) => Config)(overrides)
}

/** 安全与权限契约：此处说明固定权限、审批边界及异常回退。（涉及：`sessionProjections.stateOf`） */
const session = {
  id: 'live-session',
  seq: 0,
  header: { id: 'live-session', cwd: process.cwd() },
  inheritedEventCount: 0,
  snapshotEvents: () => [],
  eventAt: () => undefined,
}

let ctx: Context
let owner: { id: string, ctx: Context, session: typeof session }

/** 实现说明：此处记录相关接口、边界和生命周期约束。 */
async function until(predicate: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition did not become true in time')
    await new Promise(resolve => setTimeout(resolve, 100))
  }
}

beforeAll(async () => {
  ctx = new Context()
  owner = { id: session.id, ctx, session }
  // 进程与运行时契约：此处说明生命周期、身份核验、轮询或终端边界。
  // 实现说明：此处记录相关接口、边界和生命周期约束。（涉及：`provide(name, value, builtin)`）
  // 进程与运行时契约：此处说明生命周期、身份核验、轮询或终端边界。
  ;(ctx as unknown as { provide: (name: string, value: unknown, builtin: boolean) => void })
    .provide('agents', { get: (id: string) => id === owner.id ? owner : undefined }, true)
  ctx.plugin(sessionProjection)
  ctx.plugin(subprocessLocal)
  ctx.plugin(sandboxPolicy, { mode: 'danger-full-access', workspaceRoot: process.cwd() })
  ctx.plugin(TerminalSessionService)
  // 实现说明：此处记录相关接口、边界和生命周期约束。（涉及：`apply()`）
  // 测试契约：此处说明本测试锁定的行为和回归边界。
  ctx.plugin(terminalBash, backendConfig(resolved({ timeoutMs: 60_000 })))
  await until(() => (ctx.get('terminals')?.listBackends().length ?? 0) > 0)
}, TIMEOUT_MS)

afterAll(async () => {
  await (ctx as unknown as { stop?: () => Promise<void> }).stop?.()
}, TIMEOUT_MS)

describe('a human answering a prompt the model cannot', () => {
  it('lists the session, delivers typed text to a shell blocked on stdin, and reads the answer back', async () => {
    const terminals = ctx.get('terminals')
    if (terminals === undefined) throw new Error('ctx.terminals never appeared')

    const opened = await terminals.spawn(owner as never, { type: 'shell', name: 'live', cwd: process.cwd() })
    const id = opened.sessionId
    try {
      expect(opened.status.kind).toBe('running')

      // 实现说明：此处记录相关接口、边界和生命周期约束。
      const view = snapshot(ctx, session.id)
      expect(view.unavailable).toBeUndefined()
      expect(view.terminals.find(entry => entry.id === String(id))).toMatchObject({
        name: 'live', type: 'shell', running: true,
      })

      // 模型目录契约：此处说明 provider、协议、目录覆盖和用户条目保留。
      const ask = terminals.startSend(owner as never, id, {
        text: process.platform === 'win32'
          ? '$secret = Read-Host "PASSWORD"; "GOT:[$secret]"'
          : 'read -r -p "PASSWORD: " secret; echo "GOT:[$secret]"',
        submit: true,
      })
      const asked = await ask.done
      // 实现说明：此处记录相关接口、边界和生命周期约束。
      // 实现说明：此处记录相关接口、边界和生命周期约束。
      expect(['stdin_read', 'inferred_idle']).toContain(asked.waitReason)
      expect(asked.sessionStatus.kind).toBe('running')

      // 实现说明：此处记录相关接口、边界和生命周期约束。
      const typed = await sendToTerminal(
        ctx,
        { sessionId: session.id, terminalId: String(id), text: 'hunter2' },
        resolved(),
      )
      expect(typed.ok).toBe(true)

      await until(() => terminals.read(owner as never, id, { count: 60 }).text.includes('GOT:[hunter2]'))
      const page = terminals.read(owner as never, id, { count: 60 })
      expect(page.text).toContain('GOT:[hunter2]')
      // 模型目录契约：此处说明 provider、协议、目录覆盖和用户条目保留。
      // 进程与运行时契约：此处说明生命周期、身份核验、轮询或终端边界。
      expect(page.totalLines).toBeGreaterThan(0)
    } finally {
      await terminals.kill(owner as never, id, 'live test done')
    }
  }, TIMEOUT_MS)

  it('refuses a second send while one is genuinely in flight, then delivers it', async () => {
    const terminals = ctx.get('terminals')
    if (terminals === undefined) throw new Error('ctx.terminals never appeared')
    const opened = await terminals.spawn(owner as never, { type: 'shell', name: 'busy', cwd: process.cwd() })
    const id = opened.sessionId
    try {
      // 实现说明：此处记录相关接口、边界和生命周期约束。
      const held = terminals.startSend(owner as never, id, {
        text: process.platform === 'win32' ? 'Start-Sleep -Seconds 6' : 'sleep 6',
        submit: true,
      })
      // 实现说明：此处记录相关接口、边界和生命周期约束。
      // 设置写入契约：此处说明命名空间、校验、回读确认和草稿保留。
      const impatient = await sendToTerminal(
        ctx,
        { sessionId: session.id, terminalId: String(id), text: 'echo late' },
        resolved({ sendWaitMs: 500 }),
      )
      expect(impatient.ok).toBe(false)
      expect(impatient.busy).toBe(true)

      // 实现说明：此处记录相关接口、边界和生命周期约束。
      await held.done
      const patient = await sendToTerminal(
        ctx,
        { sessionId: session.id, terminalId: String(id), text: 'echo late' },
        resolved(),
      )
      expect(patient.ok).toBe(true)
      await until(() => terminals.read(owner as never, id, { count: 60 }).text.includes('late'))
    } finally {
      await terminals.kill(owner as never, id, 'live test done')
    }
  }, TIMEOUT_MS)
})
