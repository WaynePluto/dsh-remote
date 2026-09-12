import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import {
  BAD_PAYLOAD_CODE, SESSION_ID_MAX_LENGTH, WORKSPACE_PATH_MAX_LENGTH,
  WORKSPACE_PATH_MAX_SEGMENTS, completeGitOutput, dispatch, isSafeWorkspacePath,
} from '../src/index.js'
describe('security bounds', () => {
  it('bounds workspace path bytes and segment count before filesystem access', () => {
    expect(isSafeWorkspacePath('x'.repeat(WORKSPACE_PATH_MAX_LENGTH + 1))).toBe(false)
    expect(isSafeWorkspacePath(Array.from({ length: WORKSPACE_PATH_MAX_SEGMENTS + 1 }, () => 'x').join('/'))).toBe(false)
  })
  it('rejects an oversized session id before consulting agents', async () => {
    let consulted = false
    const ctx = { agents: { get: () => { consulted = true; return undefined } } } as unknown as Context
    const result = await dispatch(ctx, 'snapshot', { sessionId: 'x'.repeat(SESSION_ID_MAX_LENGTH + 1) })
    expect(result).toMatchObject({ ok: false, error: { code: BAD_PAYLOAD_CODE } })
    expect(consulted).toBe(false)
  })
  it('drops a partial porcelain record after the last complete NUL', () => {
    const input = Buffer.from('? complete.txt\0? partial')
    expect(completeGitOutput(input, true).toString()).toBe('? complete.txt\0')
    expect(completeGitOutput(Buffer.from('? partial'), true)).toHaveLength(0)
    expect(completeGitOutput(input, false)).toBe(input)
  })
})

  it("rejects an actual NUL in sessionId before consulting agents", async () => {
    let consulted = false
    const ctx = { agents: { get: () => { consulted = true; return undefined } } } as unknown as Context
    const result = await dispatch(ctx, "snapshot", { sessionId: "x" + String.fromCharCode(0) + "y" })
    expect(result).toMatchObject({ ok: false, error: { code: BAD_PAYLOAD_CODE } })
    expect(consulted).toBe(false)
  })
