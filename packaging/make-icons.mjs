// 由 packaging/dsh-station.svg 生成所有图标产物。
// packaging/dsh-station.ico：图标文件（不进发行包，供外部使用与预览）。
// packaging/win-launcher/rsrc_windows_amd64.syso：链进 dsh-station.exe 的托盘/资源图标和高 DPI 清单。
// packages/relay/src/icons.ts：relay 控制台 favicon（生成代码）。
// 命令：node packaging/make-icons.mjs [--keep]。
// 三个是源码资产，生成一次后提交；go build 自动链入 *.syso，不需 Go 模块（不用 rsrc/goversioninfo）。
// relay 将图标字节内联到 TS，避免绿色包运行时解析 node_modules 外的资源路径。
// SVG 复杂路径由 Chrome 在重生成时光栅化，避免自写光栅器和 Node 原生依赖；普通构建/运行不需 Chrome。
// 清单必须声明 DPI，否则 150%/200% 高分屏的托盘菜单和 MessageBox 会被位图拉伸；--keep 保留临时 PNG 供排查。

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inflateSync } from 'node:zlib'

const packagingDir = dirname(fileURLToPath(import.meta.url))
const sourcePath = join(packagingDir, 'dsh-station.svg')
const outputPath = join(packagingDir, 'dsh-station.ico')
// 名字里的 _windows_amd64 是 Go 的构建约束：只在 GOOS=windows GOARCH=amd64 时链入。
const resourcePath = join(packagingDir, 'win-launcher', 'rsrc_windows_amd64.syso')
// relay 页面的 favicon：生成代码，不要手改。
const relayIconsPath = join(packagingDir, '..', 'packages', 'relay', 'src', 'icons.ts')

// 16 和 32 是通知区和桌面要用的，其余是资源管理器、Alt-Tab 和高 DPI 会挑的。
// 256 以 PNG 存（Vista 起支持），否则光它一个就要 256 KB。
const sizes = [16, 20, 24, 32, 48, 64, 128, 256]

// 网页 favicon 的 .ico 只给不认 SVG favicon 的旧浏览器兜底，三个尺寸够了；
// 全尺寸那份有 113 KB，没必要 base64 进源码。
const webIcoSizes = [16, 32, 48]

// 装进 webmanifest 与 apple-touch-icon 的位图尺寸。
const webPngSize = 256

/**
 * 应用程序清单同时保证 DPI 感知和不被误判为安装器。
 * `dpiAware=true/pm` 覆盖 Win8.1，`dpiAwareness=permonitorv2,permonitor` 覆盖 Win10 1703+；
 * 两行是官方推荐写法，不声明会让托盘菜单和 MessageBox 在高分屏被位图拉伸。
 * `asInvoker` 阻止安装程序启发式检测弹 UAC。
 * 故意不声明 comctl32 v6：程序不用公共控件，SxS 依赖解析失败会直接阻止启动。
 */
function applicationManifest(version) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <assemblyIdentity type="win32" name="dsh-station" version="${version}" processorArchitecture="amd64"/>
  <description>dsh-station</description>
  <trustInfo xmlns="urn:schemas-microsoft-com:asm.v3">
    <security>
      <requestedPrivileges>
        <requestedExecutionLevel level="asInvoker" uiAccess="false"/>
      </requestedPrivileges>
    </security>
  </trustInfo>
  <application xmlns="urn:schemas-microsoft-com:asm.v3">
    <windowsSettings>
      <dpiAware xmlns="http://schemas.microsoft.com/SMI/2005/WindowsSettings">true/pm</dpiAware>
      <dpiAwareness xmlns="http://schemas.microsoft.com/SMI/2016/WindowsSettings">permonitorv2,permonitor</dpiAwareness>
    </windowsSettings>
  </application>
  <compatibility xmlns="urn:schemas-microsoft-com:compatibility.v1">
    <application>
      <!-- Windows 10 / 11 系统 -->
      <supportedOS Id="{8e0f7a12-bfb3-4fe8-b9a5-48fd50a15a9a}"/>
      <!-- Windows 8.1 系统 -->
      <supportedOS Id="{1f676c76-80e1-4239-95bb-83d0f6d0da78}"/>
    </application>
  </compatibility>
</assembly>
`
}

/** 从 launcher 的 package.json 取版本，补成清单要的四段式。 */
function manifestVersion() {
  const manifestPath = join(packagingDir, '..', 'packages', 'launcher', 'package.json')
  let version = '0.0.0'
  try {
    version = JSON.parse(readFileSync(manifestPath, 'utf8')).version ?? version
  } catch {
    // 读不到就用占位版本：清单里的版本号不影响行为。
  }
  const numbers = version.split('-')[0].split('.').map(part => Number.parseInt(part, 10) || 0)
  while (numbers.length < 4) numbers.push(0)
  return numbers.slice(0, 4).join('.')
}

function fail(message, hint) {
  console.error(message)
  if (hint) console.error(hint)
  process.exit(1)
}

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].filter(Boolean)
  const found = candidates.find((path) => existsSync(path))
  if (!found) {
    fail(
      '没找到 Chrome / Edge，无法把 SVG 渲成 PNG。',
      '设 CHROME_PATH 指向浏览器可执行文件后重试。图标只在重新生成时需要浏览器。',
    )
  }
  return found
}

function renderPngs(chrome, workDir, svg, wanted) {
  writeFileSync(join(workDir, 'icon.svg'), svg)
  const rendered = new Map()
  for (const size of wanted) {
    const pagePath = join(workDir, `page-${size}.html`)
    const pngPath = join(workDir, `icon-${size}.png`)
    writeFileSync(
      pagePath,
      `<!doctype html><meta charset="utf-8">` +
        `<style>html,body{margin:0;padding:0;background:transparent}` +
        `img{display:block;width:${size}px;height:${size}px}</style>` +
        `<img src="icon.svg">`,
    )
    execFileSync(
      chrome,
      [
        '--headless=new',
        '--disable-gpu',
        '--hide-scrollbars',
        '--force-device-scale-factor=1',
        '--default-background-color=00000000',
        `--window-size=${size},${size}`,
        `--screenshot=${pngPath}`,
        `file:///${pagePath.replaceAll('\\', '/')}`,
      ],
      { stdio: 'ignore' },
    )
    if (!existsSync(pngPath)) fail(`Chrome 没有产出 ${pngPath}。`)
    rendered.set(size, readFileSync(pngPath))
  }
  return rendered
}

// 只解 Chrome 截图会产出的那一类 PNG：8 位、非隔行、RGB 或 RGBA。
function decodePng(bytes) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  if (!bytes.subarray(0, 8).equals(signature)) fail('截图不是 PNG。')

  let offset = 8
  let width = 0
  let height = 0
  let channels = 0
  const idat = []
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset)
    const type = bytes.toString('ascii', offset + 4, offset + 8)
    const data = bytes.subarray(offset + 8, offset + 8 + length)
    offset += 12 + length
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      const depth = data[8]
      const colorType = data[9]
      const interlace = data[12]
      if (depth !== 8 || interlace !== 0 || (colorType !== 2 && colorType !== 6)) {
        fail(`不支持的 PNG 格式：depth=${depth} colorType=${colorType} interlace=${interlace}。`)
      }
      channels = colorType === 6 ? 4 : 3
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      break
    }
  }

  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const pixels = Buffer.alloc(width * height * 4)
  let previous = Buffer.alloc(stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)))
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? line[x - channels] : 0
      const up = previous[x]
      const upLeft = x >= channels ? previous[x - channels] : 0
      switch (filter) {
        case 0:
          break
        case 1:
          line[x] = (line[x] + left) & 0xff
          break
        case 2:
          line[x] = (line[x] + up) & 0xff
          break
        case 3:
          line[x] = (line[x] + ((left + up) >> 1)) & 0xff
          break
        case 4: {
          const p = left + up - upLeft
          const pa = Math.abs(p - left)
          const pb = Math.abs(p - up)
          const pc = Math.abs(p - upLeft)
          const predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft
          line[x] = (line[x] + predictor) & 0xff
          break
        }
        default:
          fail(`未知的 PNG 行过滤器 ${filter}。`)
      }
    }
    previous = line
    for (let x = 0; x < width; x++) {
      const source = x * channels
      const target = (y * width + x) * 4
      pixels[target] = line[source]
      pixels[target + 1] = line[source + 1]
      pixels[target + 2] = line[source + 2]
      pixels[target + 3] = channels === 4 ? line[source + 3] : 255
    }
  }
  return { width, height, pixels }
}

// ICO 里的 BMP 条目：BITMAPINFOHEADER + 自下而上的 BGRA + 全零 AND 掩码。
// 32 位色下没人读那个掩码，但缺了它老加载器会把条目读歪。
function encodeBmp({ width, height, pixels }) {
  const maskStride = Math.ceil(width / 32) * 4
  const header = Buffer.alloc(40)
  header.writeUInt32LE(40, 0)
  header.writeInt32LE(width, 4)
  // 高度写两倍：BMP 头把 XOR 图和 AND 掩码算作一张图。
  header.writeInt32LE(height * 2, 8)
  header.writeUInt16LE(1, 12)
  header.writeUInt16LE(32, 14)
  header.writeUInt32LE(0, 16)
  header.writeUInt32LE(width * height * 4, 20)

  const body = Buffer.alloc(width * height * 4)
  let cursor = 0
  for (let y = height - 1; y >= 0; y--) {
    for (let x = 0; x < width; x++) {
      const source = (y * width + x) * 4
      body[cursor++] = pixels[source + 2]
      body[cursor++] = pixels[source + 1]
      body[cursor++] = pixels[source]
      body[cursor++] = pixels[source + 3]
    }
  }
  return Buffer.concat([header, body, Buffer.alloc(maskStride * height)])
}

function buildIco(entries) {
  const header = Buffer.alloc(6 + 16 * entries.length)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(entries.length, 4)
  let offset = header.length
  entries.forEach(({ size, bytes }, index) => {
    const at = 6 + 16 * index
    // 256 写成 0：这个字段只有一字节，装不下 256。
    header[at] = size & 0xff
    header[at + 1] = size & 0xff
    header[at + 2] = 0
    header[at + 3] = 0
    header.writeUInt16LE(1, at + 4)
    header.writeUInt16LE(32, at + 6)
    header.writeUInt32LE(bytes.length, at + 8)
    header.writeUInt32LE(offset, at + 12)
    offset += bytes.length
  })
  return Buffer.concat([header, ...entries.map((entry) => entry.bytes)])
}

// 资源节内的图像原文对齐到 8 字节：Windows 读得懂不对齐的，但所有工具链都这么写。
const alignTo8 = value => (value + 7) & ~7

/**
 * 把同一批图像写成 COFF 资源对象文件（.syso），go build 会直接链入。
 * 不用 rsrc / goversioninfo：它们要引 Go 模块，而本仓 exe 约束是不使用 cgo/Go 模块（docs/06 §5）；
 * 图像字节已在手上，剩下的是固定格式容器。
 * 结构：IMAGE_FILE_HEADER、一个 .rsrc 节（目录树、IMAGE_RESOURCE_DATA_ENTRY、图像原文）、
 * data entry 的 ADDR32NB 重定位（OffsetToData 留节内偏移，交给链接器补 RVA，符号指向本节）。
 * 符号表含静态节符号及辅助记录，字符串表仅含 4 字节长度。
 * RT_ICON 存各图原文，RT_GROUP_ICON 串成目录，Windows 取 ID 最小的 group 作程序图标。
 * RT_MANIFEST（类型 24）ID 1 是 CREATEPROCESS_MANIFEST_RESOURCE_ID，内容为无 BOM UTF-8 XML。
 */
function buildResourceObject(entries, manifestXml) {
  const RT_ICON = 3
  const RT_GROUP_ICON = 14
  const RT_MANIFEST = 24
  const LANGUAGE = 0x0409 // en-US；图标不含文本，用哪个都行，但必须有一个
  const GROUP_ID = 1
  const MANIFEST_ID = 1

  // 先把“要放进去的东西”拉成一张平表：图标一张一条，最后一条是 group。
  const groupHeader = Buffer.alloc(6 + 14 * entries.length)
  groupHeader.writeUInt16LE(0, 0)
  groupHeader.writeUInt16LE(1, 2)
  groupHeader.writeUInt16LE(entries.length, 4)
  entries.forEach(({ size, bytes }, index) => {
    const at = 6 + 14 * index
    groupHeader[at] = size & 0xff // 256 写成 0，同 .ico
    groupHeader[at + 1] = size & 0xff
    groupHeader[at + 2] = 0 // 颜色数（0 = 256 色以上）
    groupHeader[at + 3] = 0
    groupHeader.writeUInt16LE(1, at + 4) // planes（平面数）
    groupHeader.writeUInt16LE(32, at + 6) // 位深
    groupHeader.writeUInt32LE(bytes.length, at + 8)
    groupHeader.writeUInt16LE(index + 1, at + 12) // 对应的 RT_ICON 资源 ID
  })

  const resources = [
    ...entries.map((entry, index) => ({ type: RT_ICON, id: index + 1, bytes: entry.bytes })),
    { type: RT_GROUP_ICON, id: GROUP_ID, bytes: groupHeader },
    { type: RT_MANIFEST, id: MANIFEST_ID, bytes: Buffer.from(manifestXml, 'utf8') },
  ]

  // 目录树层次：类型 → 名字/ID → 语言 → data entry。同层条目必须按 ID 升序。
  const types = [...new Set(resources.map(resource => resource.type))].toSorted((a, b) => a - b)
  const DIRECTORY_BYTES = 16
  const ENTRY_BYTES = 8
  const DATA_ENTRY_BYTES = 16

  let cursor = DIRECTORY_BYTES + ENTRY_BYTES * types.length
  const typeDirectories = types.map((type) => {
    const items = resources.filter(resource => resource.type === type).toSorted((a, b) => a.id - b.id)
    const offset = cursor
    cursor += DIRECTORY_BYTES + ENTRY_BYTES * items.length
    return { type, items, offset }
  })
  for (const directory of typeDirectories) {
    for (const item of directory.items) {
      item.languageDirectoryOffset = cursor
      cursor += DIRECTORY_BYTES + ENTRY_BYTES
    }
  }
  for (const directory of typeDirectories) {
    for (const item of directory.items) {
      item.dataEntryOffset = cursor
      cursor += DATA_ENTRY_BYTES
    }
  }
  for (const directory of typeDirectories) {
    for (const item of directory.items) {
      cursor = alignTo8(cursor)
      item.dataOffset = cursor
      cursor += item.bytes.length
    }
  }
  const sectionSize = alignTo8(cursor)
  const section = Buffer.alloc(sectionSize)

  const writeDirectory = (offset, count) => {
    section.writeUInt32LE(0, offset) // Characteristics（特征字段）
    section.writeUInt32LE(0, offset + 4) // TimeDateStamp（时间戳）
    section.writeUInt16LE(0, offset + 8) // MajorVersion（主版本）
    section.writeUInt16LE(0, offset + 10) // MinorVersion（次版本）
    section.writeUInt16LE(0, offset + 12) // 命名条目：一个都没有
    section.writeUInt16LE(count, offset + 14)
  }
  const writeEntry = (offset, id, target, isDirectory) => {
    section.writeUInt32LE(id, offset)
    // >>> 0：位运算在 JS 里是带符号 32 位的，不转回无符号写不进去。
    section.writeUInt32LE(isDirectory ? (target | 0x80000000) >>> 0 : target, offset + 4)
  }

  writeDirectory(0, types.length)
  typeDirectories.forEach((directory, index) => {
    writeEntry(DIRECTORY_BYTES + ENTRY_BYTES * index, directory.type, directory.offset, true)
    writeDirectory(directory.offset, directory.items.length)
    directory.items.forEach((item, itemIndex) => {
      writeEntry(
        directory.offset + DIRECTORY_BYTES + ENTRY_BYTES * itemIndex,
        item.id,
        item.languageDirectoryOffset,
        true,
      )
      writeDirectory(item.languageDirectoryOffset, 1)
      writeEntry(item.languageDirectoryOffset + DIRECTORY_BYTES, LANGUAGE, item.dataEntryOffset, false)
      // OffsetToData 先写节内偏移，重定位会把它加成 RVA。
      section.writeUInt32LE(item.dataOffset, item.dataEntryOffset)
      section.writeUInt32LE(item.bytes.length, item.dataEntryOffset + 4)
      section.writeUInt32LE(0, item.dataEntryOffset + 8) // CodePage（代码页）
      section.writeUInt32LE(0, item.dataEntryOffset + 12) // Reserved（保留字段）
      item.bytes.copy(section, item.dataOffset)
    })
  })

  const items = typeDirectories.flatMap(directory => directory.items)
  const RELOCATION_BYTES = 10
  const SYMBOL_BYTES = 18
  const relocations = Buffer.alloc(RELOCATION_BYTES * items.length)
  items.forEach((item, index) => {
    const at = RELOCATION_BYTES * index
    relocations.writeUInt32LE(item.dataEntryOffset, at) // 要修补的字段位置
    relocations.writeUInt32LE(0, at + 4) // 符号表下标：0 = .rsrc 节符号
    relocations.writeUInt16LE(3, at + 8) // 重定位类型：IMAGE_REL_AMD64_ADDR32NB
  })

  const HEADER_BYTES = 20
  const SECTION_HEADER_BYTES = 40
  const sectionDataOffset = HEADER_BYTES + SECTION_HEADER_BYTES
  const relocationOffset = sectionDataOffset + section.length
  const symbolOffset = relocationOffset + relocations.length

  const header = Buffer.alloc(HEADER_BYTES)
  header.writeUInt16LE(0x8664, 0) // IMAGE_FILE_MACHINE_AMD64（AMD64 文件类型）
  header.writeUInt16LE(1, 2) // 节数
  header.writeUInt32LE(0, 4) // TimeDateStamp（时间戳）：写 0，保证可重现构建
  header.writeUInt32LE(symbolOffset, 8)
  header.writeUInt32LE(2, 12) // 符号数：节符号 + 它的辅助记录
  header.writeUInt16LE(0, 16) // 可选头大小：对象文件没有
  header.writeUInt16LE(0, 18) // Characteristics（特征字段）

  const sectionHeader = Buffer.alloc(SECTION_HEADER_BYTES)
  sectionHeader.write('.rsrc', 0, 'latin1')
  sectionHeader.writeUInt32LE(0, 8) // VirtualSize（虚拟大小）
  sectionHeader.writeUInt32LE(0, 12) // VirtualAddress（虚拟地址）
  sectionHeader.writeUInt32LE(section.length, 16)
  sectionHeader.writeUInt32LE(sectionDataOffset, 20)
  sectionHeader.writeUInt32LE(relocationOffset, 24)
  sectionHeader.writeUInt32LE(0, 28) // 行号表
  sectionHeader.writeUInt16LE(items.length, 32)
  sectionHeader.writeUInt16LE(0, 34)
  // CNT_INITIALIZED_DATA | ALIGN_8BYTES | MEM_READ（资源节属性）
  sectionHeader.writeUInt32LE(0x40000040 | 0x00400000, 36)

  const symbols = Buffer.alloc(SYMBOL_BYTES * 2)
  symbols.write('.rsrc', 0, 'latin1')
  symbols.writeUInt32LE(0, 8) // Value（值）
  symbols.writeInt16LE(1, 12) // SectionNumber（1 基）
  symbols.writeUInt16LE(0, 14) // Type（类型）
  symbols[16] = 3 // IMAGE_SYM_CLASS_STATIC（静态符号类）
  symbols[17] = 1 // 辅助记录数
  symbols.writeUInt32LE(section.length, SYMBOL_BYTES) // 辅助：节长度
  symbols.writeUInt16LE(items.length, SYMBOL_BYTES + 4) // 辅助：重定位数

  const stringTable = Buffer.alloc(4)
  stringTable.writeUInt32LE(4, 0) // 只有长度字段本身

  return Buffer.concat([header, sectionHeader, section, relocations, symbols, stringTable])
}

/**
 * 写 packages/relay/src/icons.ts：relay 自己服务登录页与控制台，也就得自己服务 favicon。
 *
 * 三个形式：SVG（现代浏览器、矢量、最小）、ICO（旧浏览器兜底）、
 * PNG（webmanifest 与 iOS “添加到主屏幕”，那两个地方都不认 SVG）。
 * 二进制以 base64 内联，避免运行时读文件（见文件头的说明）。
 */
function relayIconsModule({ svg, ico, png, pngSize }) {
  return [
    '// 由 packaging/make-icons.mjs 从 packaging/dsh-station.svg 生成，不要手改。',
    '// 改图标请改那个 SVG，然后重跑：node packaging/make-icons.mjs',
    '//',
    '// 为什么内联而不是读文件：绿色包里的 relay 就地跑在 node_modules 里，',
    '// 多一个需要解析路径的资源文件只会多一个坏点。',
    "import { Buffer } from 'node:buffer'",
    '',
    '/** 矢量 favicon：现代浏览器优先用它，任意分辨率都清晰。 */',
    `export const ICON_SVG = ${JSON.stringify(svg)}`,
    '',
    `/** 旧浏览器的兜底（${webIcoSizes.join(' / ')} px）。 */`,
    `export const ICON_ICO = Buffer.from('${ico.toString('base64')}', 'base64')`,
    '',
    `/** webmanifest 与 apple-touch-icon 用的位图（${pngSize}×${pngSize}）。 */`,
    `export const ICON_PNG = Buffer.from('${png.toString('base64')}', 'base64')`,
    '',
    '/** ICON_PNG 的边长，webmanifest 的 sizes 字段要用。 */',
    `export const ICON_PNG_SIZE = ${pngSize}`,
    '',
  ].join('\n')
}

const keepWorkDir = process.argv.includes('--keep')
const chrome = findChrome()
const workDir = mkdtempSync(join(tmpdir(), 'dsh-station-icon-'))
try {
  const svg = readFileSync(sourcePath, 'utf8')
  const wanted = [...new Set([...sizes, ...webIcoSizes, webPngSize])].toSorted((a, b) => a - b)
  const pngs = renderPngs(chrome, workDir, svg, wanted)
  const bitmap = (size) => {
    const image = decodePng(pngs.get(size))
    if (image.width !== size || image.height !== size) {
      fail(`${size}px 那张截出来是 ${image.width}x${image.height}，Chrome 缩放不对。`)
    }
    return image
  }
  const entries = sizes.map((size) => {
    // 256 直接存 PNG（Vista 起支持），当位图存光它一个就要 256 KB。
    if (size === 256) return { size, bytes: pngs.get(size) }
    return { size, bytes: encodeBmp(bitmap(size)) }
  })
  mkdirSync(dirname(outputPath), { recursive: true })
  const ico = buildIco(entries)
  writeFileSync(outputPath, ico)
  console.log(
    `已写出 ${resolve(outputPath)}：${sizes.length} 个尺寸 [${sizes.join(', ')}]，${ico.length} 字节`,
  )

  const resource = buildResourceObject(entries, applicationManifest(manifestVersion()))
  writeFileSync(resourcePath, resource)
  console.log(
    `已写出 ${resolve(resourcePath)}：图标 + 应用程序清单（高 DPI 感知），${resource.length} 字节`,
  )

  const webIco = buildIco(webIcoSizes.map(size => ({ size, bytes: encodeBmp(bitmap(size)) })))
  const iconsModule = relayIconsModule({
    svg,
    ico: webIco,
    png: pngs.get(webPngSize),
    pngSize: webPngSize,
  })
  writeFileSync(relayIconsPath, iconsModule)
  console.log(
    `已写出 ${resolve(relayIconsPath)}：SVG + ICO(${webIcoSizes.join('/')}) + PNG(${webPngSize})，`
      + `${iconsModule.length} 字节`,
  )
} finally {
  if (keepWorkDir) console.log(`中间产物保留在 ${workDir}`)
  else rmSync(workDir, { recursive: true, force: true })
}
