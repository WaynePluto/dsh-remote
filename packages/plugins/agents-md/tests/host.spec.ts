/**
 * Host-half tests: the file semantics and the RPC dispatch.
 *
 * They run against a real temporary directory rather than a mocked `fs`,
 * because the two things most worth proving — that a missing file reads as an
 * empty document, and that a save is atomic — are properties of the filesystem
 * calls themselves.
 */

import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  agentsMdPath,
  BAD_REQUEST_CODE,
  dispatch,
  IO_CODE,
  readDocument,
  TOO_LARGE_CODE,
  UNKNOWN_ENDPOINT_CODE,
  USER_GLOBAL_FILE,
  writeDocument,
} from '../src/index.js'
import { documentFault, isAgentsMdEndpoint, MAX_BYTES, utf8Bytes } from '../src/shared.js'

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'agents-md-'))
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

describe('the file dsh actually reads', () => {
  it('is AGENTS.md directly under the harness home', () => {
    // The whole plugin is worthless if this path drifts from dsh's own
    // `join(config.dshHome, USER_GLOBAL_FILE)`.
    expect(USER_GLOBAL_FILE).toBe('AGENTS.md')
    expect(agentsMdPath(home)).toBe(join(home, 'AGENTS.md'))
  })
})

describe('readDocument', () => {
  it('reports a missing file as an empty document rather than failing', async () => {
    const document = await readDocument(home)
    expect(document).toMatchObject({ content: '', exists: false, bytes: 0 })
    expect(document.displayPath).toMatch(/AGENTS\.md$/u)
  })

  it('distinguishes an empty file from a missing one', async () => {
    await writeFile(agentsMdPath(home), '', 'utf8')
    expect(await readDocument(home)).toMatchObject({ content: '', exists: true, bytes: 0 })
  })

  it('reads contents verbatim and measures them in UTF-8 bytes', async () => {
    await writeFile(agentsMdPath(home), '规则：不要猜\n', 'utf8')
    const document = await readDocument(home)
    expect(document.content).toBe('规则：不要猜\n')
    expect(document.bytes).toBe(utf8Bytes('规则：不要猜\n'))
    expect(document.bytes).toBeGreaterThan('规则：不要猜\n'.length)
  })
})

describe('writeDocument', () => {
  it('creates the file and the harness home when neither exists', async () => {
    const nested = join(home, 'deeper', 'still')
    await writeDocument('hello', nested)
    expect(await readFile(join(nested, 'AGENTS.md'), 'utf8')).toBe('hello')
  })

  it('replaces contents wholesale rather than appending', async () => {
    await writeDocument('first', home)
    await writeDocument('second', home)
    expect(await readFile(agentsMdPath(home), 'utf8')).toBe('second')
  })

  it('leaves no temporary file behind', async () => {
    await writeDocument('content', home)
    expect((await readdir(home)).filter(entry => entry.endsWith('.tmp'))).toEqual([])
    expect(await readdir(home)).toEqual(['AGENTS.md'])
  })

  it('round-trips through readDocument', async () => {
    await writeDocument('# 全局\n\n- 一条规则\n', home)
    expect(await readDocument(home)).toMatchObject({ content: '# 全局\n\n- 一条规则\n', exists: true })
  })
})

describe('the shared validator', () => {
  it('accepts a document at the limit and refuses one past it', () => {
    expect(documentFault('x'.repeat(MAX_BYTES))).toBeUndefined()
    expect(documentFault('x'.repeat(MAX_BYTES + 1))).toBe('too-large')
  })

  it('measures multi-byte characters as dsh does, not by string length', () => {
    // A document of 600_000 Chinese characters is under the character count but
    // far over the byte budget; measuring by `.length` would let it through.
    const text = '规'.repeat(600_000)
    expect(text.length).toBeLessThan(MAX_BYTES)
    expect(documentFault(text)).toBe('too-large')
  })
})

describe('dispatch', () => {
  it('serves only its own endpoints', () => {
    expect(isAgentsMdEndpoint('load')).toBe(true)
    expect(isAgentsMdEndpoint('save')).toBe(true)
    expect(isAgentsMdEndpoint('delete')).toBe(false)
  })

  it('refuses an unknown endpoint', async () => {
    const result = await dispatch('nope', {})
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe(UNKNOWN_ENDPOINT_CODE)
  })

  it('refuses a save whose payload is not a string', async () => {
    for (const payload of [{}, { content: 42 }, { content: null }, undefined]) {
      const result = await dispatch('save', payload)
      expect(result.ok).toBe(false)
      if (result.ok) continue
      expect(result.error.code).toBe(BAD_REQUEST_CODE)
    }
  })

  it('refuses an oversized document with a code of its own', async () => {
    const result = await dispatch('save', { content: 'x'.repeat(MAX_BYTES + 1) })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe(TOO_LARGE_CODE)
  })

  it('reports an io failure as a coded failure rather than throwing', async () => {
    // A directory where the file should be makes every read fail with EISDIR.
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = join(home, 'blocked')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(home, 'blocked', 'AGENTS.md'), { recursive: true })
    try {
      const result = await dispatch('load', {})
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.error.code).toBe(IO_CODE)
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    }
  })

  it('loads and saves through the resolved harness home', async () => {
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = home
    try {
      expect(await dispatch('load', {})).toMatchObject({ ok: true, value: { exists: false } })
      const saved = await dispatch('save', { content: 'a rule' })
      expect(saved).toMatchObject({ ok: true, value: { document: { content: 'a rule', exists: true } } })
      expect(await readFile(agentsMdPath(home), 'utf8')).toBe('a rule')
      expect(await dispatch('load', {})).toMatchObject({ ok: true, value: { content: 'a rule' } })
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    }
  })
})
