/** Browser-safe workspace path helpers shared by Git decoration and the context menu. */

/** Normalize host paths to the slash form used by the native tree and Git wire data. */
export function slashPath(path: string): string {
  return path.replaceAll('\\', '/')
}

function trimRoot(path: string): string {
  const normalized = slashPath(path)
  if (normalized === '/') return normalized
  if (/^\/\/$/u.test(normalized)) return normalized
  return normalized.replace(/\/+$/u, '')
}

function isCaseInsensitivePath(path: string): boolean {
  return /^[A-Za-z]:\//u.test(path) || path.startsWith('//')
}

/**
 * Convert an absolute native-tree path to the workspace-relative slash path.
 *
 * Native ui-sidebar-files deliberately joins Windows parents with `/`, so this
 * helper accepts mixed separators. It refuses a path outside the supplied root
 * rather than guessing a relative path, which is important for both Git lookup
 * and copying a path from a row that is no longer rooted in this session.
 */
export function workspaceRelativePath(root: string, target: string): string | undefined {
  const base = trimRoot(root)
  const value = slashPath(target)
  const insensitive = isCaseInsensitivePath(base)
  const equal = (left: string, right: string): boolean => insensitive
    ? left.toLocaleLowerCase('en-US') === right.toLocaleLowerCase('en-US')
    : left === right
  if (equal(base, value)) return ''
  const prefix = base === '/' ? '/' : `${base}/`
  const left = insensitive ? value.toLocaleLowerCase('en-US') : value
  const right = insensitive ? prefix.toLocaleLowerCase('en-US') : prefix
  if (!left.startsWith(right)) return undefined
  return value.slice(prefix.length)
}

/** Restore a target-platform absolute path from a slash-relative workspace path. */
export function absolutePathOf(root: string, relative: string): string {
  if (relative === '') return root
  const separator = root.includes('\\') ? '\\' : '/'
  const base = root.replace(/[\\/]+$/u, '')
  const value = relative.split('/').join(separator)
  if (base === '') return `${separator}${value}`
  return `${base}${separator}${value}`
}
