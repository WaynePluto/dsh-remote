/** 纯 Node 的最小 .deb 构建器（S8.3 Linux 桌面安装包）。
 *
 * .deb = ar 归档 { debian-binary, control.tar.gz, data.tar.gz }；
 * tar 用 ustar + GNU 'L' 长名条目（pnpm 的嵌套路径常超 100 字节），
 * gzip 用 zlib。不依赖系统 ar/tar，Windows 上也能构建，但最终
 * dpkg 可安装性要等 Linux 实机验收（S10.3）。
 */
import { readdirSync, readFileSync, readlinkSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { gzipSync } from 'node:zlib'

const USTAR_MAGIC = 'ustar\x0000'

/** 512 字节 tar 头；typeflag '0' 文件、'5' 目录、'2' 符号链接、'L' GNU 长名。 */
function tarHeader(name, { mode = 0o644, size = 0, mtime = 0, typeflag = '0', linkname } = {}) {
  const header = Buffer.alloc(512)
  const write = (offset, length, value) => {
    header.write(value.length <= length ? value : value.slice(0, length), offset, 'utf8')
  }
  const octal = (offset, length, value) => {
    header.write(value.toString(8).padStart(length - 1, '0') + '\0', offset, 'utf8')
  }
  write(0, 100, name)
  octal(100, 8, mode)
  octal(108, 8, 0) // uid
  octal(116, 8, 0) // gid
  octal(124, 12, size)
  octal(136, 12, mtime)
  header.write('        ', 148, 'utf8') // 校验和先按空格计算
  header.write(typeflag, 156, 'utf8')
  if (linkname !== undefined) write(157, 100, linkname)
  write(257, 8, USTAR_MAGIC)
  write(265, 32, 'root') // uname
  write(297, 32, 'root') // gname
  let checksum = 0
  for (const byte of header) checksum += byte
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 'utf8')
  return header
}

function tarPadded(content) {
  const remainder = content.length % 512
  if (remainder === 0) return content
  return Buffer.concat([content, Buffer.alloc(512 - remainder)])
}

/** 递归收集目录为 tar 条目；entryPath 相对 dataRoot，落盘路径以 posixTarget 开头。
 * executables 是绝对路径集合，命中的文件落盘 0o755。 */
function collectEntries(directory, dataRoot, posixTarget, executables) {
  const entries = []
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const absolute = join(current, entry.name)
      const relativePath = relative(dataRoot, absolute).split(sep).join('/')
      const targetPath = `${posixTarget}/${relativePath}`
      if (entry.isDirectory()) {
        entries.push({ name: `${targetPath}/`, typeflag: '5', mode: 0o755, size: 0 })
        walk(absolute)
      } else if (entry.isFile()) {
        const mode = executables.has(absolute) ? 0o755 : 0o644
        entries.push({ name: targetPath, typeflag: '0', mode, size: statSync(absolute).size, absolute })
      } else if (entry.isSymbolicLink()) {
        // pnpm 在类 Unix 上用相对符号链接组织 node_modules/.bin 与包间引用；
        // tar 以 '2' 条目原样保留 linkname，dpkg 解包后相对关系不变。
        entries.push({ name: targetPath, typeflag: '2', mode: 0o777, size: 0, linkname: readlinkSync(absolute) })
      } else {
        throw new Error(`deb 打包不支持特殊文件：${absolute}`)
      }
    }
  }
  walk(directory)
  return entries
}

function pushTarEntry(chunks, entry, mtime) {
  // 超长路径用 GNU 'L' 条目承载；'L' 本体的 size 是路径字节长度。
  if (Buffer.byteLength(entry.name, 'utf8') > 100) {
    const longName = Buffer.from(`${entry.name}\0`, 'utf8')
    chunks.push(tarHeader('././@LongLink', { mode: 0o644, size: longName.length, mtime, typeflag: 'L' }))
    chunks.push(tarPadded(longName))
  }
  chunks.push(tarHeader(entry.name, { mode: entry.mode, size: entry.size, mtime, typeflag: entry.typeflag }))
  if (entry.typeflag === '0') chunks.push(tarPadded(readFileSync(entry.absolute)))
}

/** 构建一个 tar.gz；entries 为 { name, typeflag, mode, size, absolute? }。 */
function buildTarGz(entries, mtime) {
  const chunks = []
  for (const entry of entries) pushTarEntry(chunks, entry, mtime)
  chunks.push(Buffer.alloc(1024)) // 两块全零结尾
  return gzipSync(Buffer.concat(chunks), { level: 6, mtime: 0 })
}

/** ar 的 60 字节成员头。 */
function arHeader(name, size, mtime) {
  const header = Buffer.alloc(60)
  header.write(`${name}/`.padEnd(16, ' '), 0, 'utf8')
  header.write(String(mtime).padEnd(12, ' '), 16, 'utf8')
  header.write('0'.padEnd(6, ' '), 28, 'utf8') // uid
  header.write('0'.padEnd(6, ' '), 34, 'utf8') // gid
  header.write('100644'.padEnd(8, ' '), 40, 'utf8')
  header.write(String(size).padEnd(10, ' '), 48, 'utf8')
  header.write('`\n', 58, 'utf8')
  return header
}

function arMember(name, content, mtime) {
  const padded = content.length % 2 === 0 ? content : Buffer.concat([content, Buffer.alloc(1)])
  return Buffer.concat([arHeader(name, content.length, mtime), padded])
}

/**
 * 构建 .deb。
 * @param options.data { directory, target } 被打包目录与其安装前缀（如 /opt/dsh-station）。
 * @param options.control 包元数据（package/version/architecture/maintainer/description/depends）。
 * @param options.output deb 输出路径。
 */
export function buildDeb(options) {
  const mtime = Math.floor(Date.now() / 1000)

  const controlText = Object.entries({
    Package: options.control.package,
    Version: options.control.version,
    Architecture: options.control.architecture,
    Maintainer: options.control.maintainer,
    ...(options.control.depends === undefined ? {} : { Depends: options.control.depends }),
    Section: 'utils',
    Priority: 'optional',
    Description: options.control.description,
  }).map(([key, value]) => `${key}: ${value}`).join('\n') + '\n'
  const controlChunks = [
    tarHeader('./control', { mode: 0o644, size: Buffer.byteLength(controlText), mtime }),
    tarPadded(Buffer.from(controlText, 'utf8')),
    Buffer.alloc(1024),
  ]
  const controlTar = gzipSync(Buffer.concat(controlChunks), { level: 6, mtime: 0 })

  const dataEntries = [
    { name: `${options.data.target}/`, typeflag: '5', mode: 0o755, size: 0 },
    ...collectEntries(options.data.directory, options.data.directory, options.data.target,
      new Set(options.data.executables ?? [])),
  ]
  const dataTar = buildTarGz(dataEntries, mtime)

  mkdirSync(dirname(options.output), { recursive: true })
  const deb = Buffer.concat([
    Buffer.from('!<arch>\n', 'utf8'),
    arMember('debian-binary', Buffer.from('2.0\n', 'utf8'), mtime),
    arMember('control.tar.gz', controlTar, mtime),
    arMember('data.tar.gz', dataTar, mtime),
  ])
  writeFileSync(options.output, deb)
  return deb.length
}
