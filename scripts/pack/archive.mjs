import {
  createWriteStream,
  readdirSync,
  statSync,
} from 'node:fs'
import { join } from 'node:path'
import { ZipArchive } from 'archiver'

/** 判断 zip 条目是否属于 pnpm 的 registry 账本。 */
export function isPnpmBookkeeping(name, patterns) {
  const normalized = name.replaceAll('\\', '/')
  return patterns.some(pattern => pattern.test(normalized))
}

export function directorySize(directory) {
  let bytes = 0
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) bytes += directorySize(path)
    else if (entry.isFile()) bytes += statSync(path).size
  }
  return bytes
}

export function formatSize(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** 按清单写 zip，过滤 pnpm 账本并保留 POSIX 与 bin 脚本的执行位。 */
export async function createZip(context, prefix, output, files, withExecutable) {
  const archive = new ZipArchive({ zlib: { level: 6 } })
  const stream = createWriteStream(output)
  const finished = new Promise((settle, reject) => {
    stream.on('close', settle)
    stream.on('error', reject)
    archive.on('error', reject)
    archive.on('warning', reject)
  })
  archive.pipe(stream)
  for (const file of files) {
    archive.file(join(context.packageDir, file.name), { name: `${prefix}/${file.name}`, mode: file.mode })
  }
  archive.file(join(context.packageDir, 'package.json'), { name: `${prefix}/package.json`, mode: 0o644 })
  if (withExecutable) {
    archive.file(join(context.packageDir, context.winExecutable), {
      name: `${prefix}/${context.winExecutable}`,
      mode: 0o755,
    })
  }
  archive.directory(join(context.packageDir, 'dist'), `${prefix}/dist`)
  archive.directory(join(context.packageDir, 'node_modules'), `${prefix}/node_modules`, (entry) => {
    if (isPnpmBookkeeping(entry.name, context.pnpmBookkeeping)) return false
    if (context.binScript.test(entry.name.replaceAll('\\', '/'))) entry.mode = 0o755
    return entry
  })
  await archive.finalize()
  await finished
  return archive.pointer()
}
