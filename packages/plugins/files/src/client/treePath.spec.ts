import { describe, expect, it } from 'vitest'
import { absolutePathOf, slashPath, workspaceRelativePath } from './treePath.js'

describe('workspace tree paths', () => {
  it('accepts the native mixed Windows separators and keeps the relative slash form', () => {
    expect(workspaceRelativePath('C:\\Work\\Repo', 'C:\\Work\\Repo/src\\main.ts')).toBe('src/main.ts')
    expect(workspaceRelativePath('C:\\Work\\Repo', 'c:/work/repo/README.md')).toBe('README.md')
    expect(absolutePathOf('C:\\Work\\Repo', 'src/main.ts')).toBe('C:\\Work\\Repo\\src\\main.ts')
  })

  it('handles POSIX and UNC roots without accepting a sibling path', () => {
    expect(workspaceRelativePath('/work/repo', '/work/repo/docs/a.md')).toBe('docs/a.md')
    expect(workspaceRelativePath('/work/repo', '/work/repository/a.md')).toBeUndefined()
    expect(workspaceRelativePath('\\\\server\\share\\repo', '\\\\SERVER\\SHARE\\repo\\a.txt')).toBe('a.txt')
  })

  it('normalizes only separators, leaving names and spaces intact', () => {
    expect(slashPath('a\\b c\\d')).toBe('a/b c/d')
    expect(workspaceRelativePath('/work/repo', '/work/repo/a b/c.txt')).toBe('a b/c.txt')
  })
})
