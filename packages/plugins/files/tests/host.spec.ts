import type { Context } from '@deepseek-ai/cordis'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  BAD_PAYLOAD_CODE, SESSION_NOT_FOUND_CODE, UNKNOWN_ENDPOINT_CODE,
  dispatch, isSafeWorkspacePath, parseGitPorcelainV2, statusForPath,
  type GitStatusEntry,
} from '../src/index.js'

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'dsh-files-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

function context(cwd: string | null = root): Context {
  return { agents: { get: () => cwd === null ? undefined : { session: { header: { cwd } } } } } as unknown as Context
}

describe('shared Git contract', () => {
  it('accepts only canonical workspace-relative slash paths used by Git data', () => {
    expect(isSafeWorkspacePath('src/a.ts')).toBe(true)
    expect(isSafeWorkspacePath('', true)).toBe(true)
    for (const path of ['', '../x', 'a/../x', '/abs', 'C:/x', 'a\\b', 'a//b', 'a/']) {
      expect(isSafeWorkspacePath(path)).toBe(false)
    }
  })

  it('aggregates descendants with the strongest status', () => {
    const statuses: GitStatusEntry[] = [
      { path: 'src/a.ts', status: 'modified' },
      { path: 'src/nested/b.ts', status: 'conflict' },
      { path: 'README.md', status: 'untracked' },
    ]
    expect(statusForPath('src', true, statuses)).toBe('conflict')
    expect(statusForPath('src/a.ts', false, statuses)).toBe('modified')
    expect(statusForPath('', true, statuses)).toBe('conflict')
    expect(statusForPath('missing', false, statuses)).toBeUndefined()
  })
})

describe('Git porcelain v2', () => {
  it('parses ordinary, renamed, untracked and conflicted records', () => {
    const output = [
      '1 M. N... 100644 100644 100644 abc def src/a.ts',
      '2 R. N... 100644 100644 100644 abc def R100 src/new.ts', 'src/old.ts',
      '? new file.txt',
      'u UU N... 100644 100644 100644 100644 a b c conflict.ts', '',
    ].join('\0')
    expect(parseGitPorcelainV2(output).entries).toEqual([
      { path: 'conflict.ts', status: 'conflict' },
      { path: 'new file.txt', status: 'untracked' },
      { path: 'src/a.ts', status: 'modified' },
      { path: 'src/new.ts', status: 'renamed' },
    ])
    expect(parseGitPorcelainV2('? packages/app/new.ts\0', 2000, 'packages/app/').entries)
      .toEqual([{ path: 'new.ts', status: 'untracked' }])
  })

  it('caps entries and drops paths outside the slash contract', () => {
    const output = ['? a', '? b', '? ../escape', ''].join('\0')
    const result = parseGitPorcelainV2(output, 1)
    expect(result.entries).toEqual([{ path: 'a', status: 'untracked' }])
    expect(result.truncated).toBe(true)
  })
})

describe('Git snapshot RPC', () => {
  const deps = {
    git: async () => ({ available: false, entries: [], truncated: false }),
  }

  it('exposes only snapshot and rejects malformed/unknown endpoint requests', async () => {
    expect(await dispatch(context(), 'delete', {})).toMatchObject({ ok: false, error: { code: UNKNOWN_ENDPOINT_CODE } })
    expect(await dispatch(context(), 'list', { sessionId: 's', path: 'src' }, deps))
      .toMatchObject({ ok: false, error: { code: UNKNOWN_ENDPOINT_CODE } })
    expect(await dispatch(context(), 'snapshot', {}, deps))
      .toMatchObject({ ok: false, error: { code: BAD_PAYLOAD_CODE } })
  })

  it('takes cwd from the requested live session', async () => {
    expect(await dispatch(context(), 'snapshot', { sessionId: 's' }, deps)).toEqual({
      ok: true, value: { workspacePath: root, git: { available: false, entries: [], truncated: false } },
    })
  })

  it('does not fall back to process.cwd for a missing session', async () => {
    expect(await dispatch(context(null), 'snapshot', { sessionId: 'missing' }, deps))
      .toMatchObject({ ok: false, error: { code: SESSION_NOT_FOUND_CODE } })
  })
})

it('runs the Git status command with supported arguments', async () => {
  const { spawnSync } = await import('node:child_process')
  const init = spawnSync('git', ['init', '--quiet'], { cwd: root, stdio: 'ignore' })
  if (init.status !== 0) return
  await writeFile(join(root, 'new.txt'), 'new', 'utf8')
  const { gitSnapshot } = await import('../src/git.js')
  const snapshot = await gitSnapshot(root)
  expect(snapshot.available).toBe(true)
  expect(snapshot.entries).toContainEqual({ path: 'new.txt', status: 'untracked' })
})

it('reports paths relative to a session cwd inside a repository', async () => {
  const { spawnSync } = await import('node:child_process')
  const init = spawnSync('git', ['init', '--quiet'], { cwd: root, stdio: 'ignore' })
  if (init.status !== 0) return
  const nested = join(root, 'packages', 'app')
  await mkdir(nested, { recursive: true })
  await writeFile(join(nested, 'new.ts'), 'new', 'utf8')
  const { gitSnapshot } = await import('../src/git.js')
  const snapshot = await gitSnapshot(nested)
  expect(snapshot.available).toBe(true)
  expect(snapshot.entries).toContainEqual({ path: 'new.ts', status: 'untracked' })
})
