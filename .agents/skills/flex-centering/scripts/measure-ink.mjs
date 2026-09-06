/**
 * 量一张 UI 截图里各元素的**墨迹**包围盒与竖直中心。
 *
 * 用途：判断「图标比文字高一点」到底差多少像素 —— 肉眼只能说「差一点」，这个脚本
 * 给出具体数字，之后才谈得上补多少光学位移（见 SKILL.md 第三层）。
 *
 * 用法：
 *   node .agents/skills/flex-centering/scripts/measure-ink.mjs <图片路径> [亮度阈值]
 *
 * 输出每一「簇」（相邻的有墨列聚成一簇，用 >=4 列空白断开）的 x/y 范围、高度与中心。
 * 一行「图标 + 标题 + 副标题 + 箭头」通常正好是四簇，比较它们的 centre 即可。
 *
 * 注意：
 * - 截图必须是 1×（没有缩放）。判断方法：已知 14px 的图标应当量出 14 行左右。
 * - 深色主题下墨迹比背景**亮**，把阈值取反或先反色，本脚本默认按浅色主题（暗墨迹）。
 * - 依赖 `sharp`（本仓库 node_modules 里已有）。
 */
import { argv, exit } from 'node:process'
import sharp from 'sharp'

const [, , file, threshold = '150'] = argv
if (file === undefined) {
  console.error('用法: node measure-ink.mjs <图片路径> [亮度阈值，默认 150]')
  exit(1)
}

const { data, info } = await sharp(file).greyscale().raw().toBuffer({ resolveWithObject: true })
const { width, height, channels } = info
const THRESHOLD = Number(threshold)

const at = (x, y) => data[(y * width + x) * channels]

/** 每一列的墨迹上下界。 */
const columns = []
for (let x = 0; x < width; x += 1) {
  let top = -1
  let bottom = -1
  for (let y = 0; y < height; y += 1) {
    if (at(x, y) < THRESHOLD) {
      if (top === -1) top = y
      bottom = y
    }
  }
  columns.push({ x, top, bottom, ink: top !== -1 })
}

/** 相邻的有墨列聚成一簇；>=4 列空白算断开。 */
const clusters = []
let current = null
let blanks = 0
for (const column of columns) {
  if (column.ink) {
    blanks = 0
    if (current === null) current = { from: column.x, to: column.x, top: column.top, bottom: column.bottom }
    else {
      current.to = column.x
      current.top = Math.min(current.top, column.top)
      current.bottom = Math.max(current.bottom, column.bottom)
    }
  } else {
    blanks += 1
    if (current !== null && blanks >= 4) { clusters.push(current); current = null }
  }
}
if (current !== null) clusters.push(current)

console.log(`image ${width}x${height}  threshold ${THRESHOLD}`)
for (const cluster of clusters) {
  const centre = (cluster.top + cluster.bottom) / 2
  console.log(
    `x ${String(cluster.from).padStart(4)}..${String(cluster.to).padStart(4)}`,
    `y ${String(cluster.top).padStart(4)}..${String(cluster.bottom).padStart(4)}`,
    `h ${String(cluster.bottom - cluster.top + 1).padStart(4)}`,
    `centre ${centre.toFixed(1)}`,
  )
}
