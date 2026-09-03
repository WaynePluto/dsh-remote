/**
 * The only test that spawns a real PTY.
 *
 * Everything else in this package injects a scripted registry, which is right
 * for branch logic and useless for the one claim the whole plugin rests on: that
 * text handed to `ctx.terminals.startSend` reaches a shell that is BLOCKED ON A
 * PROMPT, and that the answer comes back. Whether an interactive `Read-Host` or
 * `read` actually consumes those bytes is a property of the operating system,
 * node-pty and dsh's backend together — it can only be found out by doing it.
 *
 * The composition is the real one, minus dsh: `dsh-subprocess-local` (node-pty),
 * `dsh-sandbox-policy`, `dsh-session-projection`, `dsh-terminal` and
 * `dsh-terminal-bash`. Only the Agent is a stand-in, because ownership in the
 * registry is compared by object identity and an identity is all it needs.
 *
 * @module @dsh-remote/dsh-plugin-terminal/tests/live
 */

import { Context } from '@deepseek-ai/cordis'
import TerminalSessionService from '@deepseek-ai/dsh-terminal'
import * as terminalBash from '@deepseek-ai/dsh-terminal-bash'
import sandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import sessionProjection from '@deepseek-ai/dsh-session-projection'
import subprocessLocal from '@deepseek-ai/dsh-subprocess-local'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Config, backendConfig, sendToTerminal, snapshot } from '../src/index.js'

/** Starting a shell, waiting for its prompt and typing into it is not fast. */
const TIMEOUT_MS = 90_000

/**
 * Resolve a configuration the way cordis does before `apply` sees it.
 * @param overrides - the fields a test cares about.
 * @returns the resolved configuration.
 */
function resolved(overrides: Record<string, unknown> = {}): Config {
  return new (Config as unknown as new (value: unknown) => Config)(overrides)
}

/**
 * Everything the backend reads off a Session, and nothing more.
 *
 * `sessionProjections.stateOf` folds the in-memory log to answer "what sandbox
 * mode is this session in"; an empty log answers "the default", which is what a
 * test wants.
 */
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

/**
 * Wait for a condition, polling.
 * @param predicate - what must become true.
 * @param timeoutMs - how long to wait.
 * @returns nothing; throws on timeout.
 */
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
  // The registry only accepts an owner the agents service still hands back for
  // that id, by reference. This is that service. `provide(name, value, builtin)`
  // is cast because the published typings only describe declared services.
  ;(ctx as unknown as { provide: (name: string, value: unknown, builtin: boolean) => void })
    .provide('agents', { get: (id: string) => id === owner.id ? owner : undefined }, true)
  ctx.plugin(sessionProjection)
  ctx.plugin(subprocessLocal)
  ctx.plugin(sandboxPolicy, { mode: 'danger-full-access', workspaceRoot: process.cwd() })
  ctx.plugin(TerminalSessionService)
  // The backend is configured exactly as `apply()` configures it, which is the
  // only way this test can prove the PSReadLine hardening actually works.
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

      // What the panel polls for: the session shows up under this conversation.
      const view = snapshot(ctx, session.id)
      expect(view.unavailable).toBeUndefined()
      expect(view.terminals.find(entry => entry.id === String(id))).toMatchObject({
        name: 'live', type: 'shell', running: true,
      })

      // What the model would do: run something that then sits on a prompt.
      const ask = terminals.startSend(owner as never, id, {
        text: process.platform === 'win32'
          ? '$secret = Read-Host "PASSWORD"; "GOT:[$secret]"'
          : 'read -r -p "PASSWORD: " secret; echo "GOT:[$secret]"',
        submit: true,
      })
      const asked = await ask.done
      // The send returns while the command is still waiting — that is the whole
      // reason a human gets a turn at all. It never means the command exited.
      expect(['stdin_read', 'inferred_idle']).toContain(asked.waitReason)
      expect(asked.sessionStatus.kind).toBe('running')

      // What the panel does: one ordinary send through this plugin's own path.
      const typed = await sendToTerminal(
        ctx,
        { sessionId: session.id, terminalId: String(id), text: 'hunter2' },
        resolved(),
      )
      expect(typed.ok).toBe(true)

      await until(() => terminals.read(owner as never, id, { count: 60 }).text.includes('GOT:[hunter2]'))
      const page = terminals.read(owner as never, id, { count: 60 })
      expect(page.text).toContain('GOT:[hunter2]')
      // The model never saw the secret in its own arguments; it is in the
      // shell's transcript, which is where a terminal puts what you type.
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
      // Hold the session with a send that cannot settle quickly.
      const held = terminals.startSend(owner as never, id, {
        text: process.platform === 'win32' ? 'Start-Sleep -Seconds 6' : 'sleep 6',
        submit: true,
      })
      // A short window is guaranteed to expire mid-sleep: the refusal is real,
      // and it is the one the panel keeps the user's draft for.
      const impatient = await sendToTerminal(
        ctx,
        { sessionId: session.id, terminalId: String(id), text: 'echo late' },
        resolved({ sendWaitMs: 500 }),
      )
      expect(impatient.ok).toBe(false)
      expect(impatient.busy).toBe(true)

      // Waiting long enough delivers it instead — the default behaviour.
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
