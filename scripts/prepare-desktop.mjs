import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const source = join(root, 'packaging', 'win-launcher', 'rsrc_windows_amd64.syso')
const target = join(root, 'packages', 'desktop', 'rsrc_windows_amd64.syso')

if (!existsSync(source)) {
  throw new Error(`缺少 Windows 图标与 DPI 资源：${source}`)
}

mkdirSync(dirname(target), { recursive: true })
const unchanged = existsSync(target) && readFileSync(source).equals(readFileSync(target))
if (!unchanged) copyFileSync(source, target)
console.log(`[desktop] Windows 资源${unchanged ? '已经是最新版本' : '已准备'}：${target}`)
