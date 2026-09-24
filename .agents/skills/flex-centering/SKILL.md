---
name: flex-centering
description: 在浏览器 UI 里做「图标 + 文字」一行的竖直居中，以及任何需要多个块严格对齐的布局。当写 dock 卡片 / 表头 / 工具栏 / 列表行、或用户反馈「图标比文字高一点 / 没对齐 / 差一点点」时使用；给出优先 flex、层层嵌套居中、以及最后那 1~2px 光学位移的判定与量法。不适用于页面级栅格（那是 grid 的事）或纯文本排版。
---

# flex 居中：图标与文字为什么总差 1~2px

本 skill 来自 dsh-station 三张 input dock 卡片（services / terminal / turn-retry）的一次实战返工：
表面是「图标比标题高一点」，实际踩了三层不同的坑，**顺序不能颠倒**。

## 铁律

1. **UI 对齐优先用 flex，不要靠写死尺寸兜底。** 「把三个盒子都调成 20px 高」能修好当下那一屏，
   但换字号、换语言、加一个更高的按钮就又歪了。
2. **层层嵌套居中**：每一层容器都自己 `display:flex` + `align-items:center`，而不是指望某一层
   的 `align-items` 能穿透下去。
3. **flex 全做对之后仍差 1~2px，那不是布局问题，是字体问题**，只能做一次光学位移 —— 但**必须先
   量再改**，不许拍脑袋加 px。

## 第一层：等高，而不是等尺寸

`align-items: center` 对齐的是**盒子中心**。如果一行里图标格 14px、标题行高 24px、副标题行高
20px，三个盒子高度不同，它们的中心确实对齐了，但**每个盒子里内容所在的位置不同**，看上去就是没
对齐。

```
表头容器            display:flex; align-items:stretch   ← 所有格子被拉成同一高度（由内容决定）
├ 图标格            display:flex; align-items:center; justify-content:center; line-height:0
│  └ <svg>
├ 标题              display:flex; align-items:center
├ 副标题            display:flex; align-items:center; min-width:0
│  └ 内层 span      overflow:hidden; text-overflow:ellipsis; white-space:nowrap
└ 箭头格            display:flex; align-items:center; justify-content:center; line-height:0
   └ <svg>
```

要点：

- 容器用 **`align-items: stretch`**（flex 默认值）让所有格子等高，高度由内容决定，**不写数字**。
- 每个格子**自己**再 `display:flex; align-items:center` 把内容居中。这就是「层层嵌套」。
- 行高不要各写各的：等高之后就不需要靠 `line-height` 去凑。
- 一行里不该被拉高的元素（例如右侧按钮）给 `align-self: center`，否则标题换行时它会跟着变高。

## 第二层：两个只在 flex 里出现的坑

- ⚠️ **flex 容器自己做不了 `text-overflow: ellipsis`。** 需要省略号的那段文字必须再包**一层
  span**，把 `overflow/text-overflow/white-space` 写在内层；外层 flex 格子只负责居中，并且要写
  `min-width: 0`，否则它不肯被压缩，省略号永远不出现。
- ⚠️ **放 svg 的格子写 `line-height: 0`。** svg 作为 flex item 会被 blockify，但只要格子里混进
  任何文本节点（JSX 里一个换行空白就够），行盒的**半行距**会把图标顶偏一两像素。归零后这一格的
  高度只由 svg 自己决定。

## 第三层：剩下的 1~2px 是字体的，先量再改

**几何居中 ≠ 视觉居中。** svg 按几何中心摆，而汉字（以及大部分 CJK 字体）的字面在行盒里天然
偏下，于是图标看起来永远比文字**高**一点点。这一步 flex 补不回来。

**先量。** 截一张真实页面的图（不要拿单独预览定稿），用本 skill 自带的脚本读墨迹包围盒：

```powershell
node .agents/skills/flex-centering/scripts/measure-ink.mjs <截图路径>
```

它逐列扫描暗像素、把相邻列聚成簇，再打印每一簇的 y 范围与中心。一行「图标 + 标题 + 副标题 +
箭头」正好是四簇，直接比 `centre` 即可。⚠️ 截图必须是 1×：已知 14px 的图标应当量出约 14 行。

实测（dsh-station 的服务卡片，13px 表头）：

| 元素 | ink y 范围 | 中心 |
|---|---|---|
| 图标 | 40–53 | 46.5 |
| 标题（汉字） | 41–55 | 48.0 |
| 副标题（汉字+数字） | 41–55 | 48.0 |

两段文字中心完全一致（说明 flex 做对了），图标高 1.5px。补位移之后再量一张：图标 35.5、标题
35.0、副标题 35.0 —— 残差 0.5px，已在半像素以内，肉眼判定通过。

**再改。** 给图标格加光学位移：

```ts
// 1.5px ÷ 13px ≈ 0.115em
transform: 'translateY(0.115em)'
```

- 写 **em** 不写 px：字号变了它跟着变。
- 用 **transform** 不用 margin/padding：纯视觉位移，不参与布局，不会把等高的格子挤歪。
- 同一行里所有图标（含右侧的折叠箭头）用**同一个常量**，让所有字形共用一个视觉中心。
- 常量旁边**必须写下当时量到的数字**，否则下一个人只会看到一个魔法值。

## 判定顺序（照这个顺序查，不要跳步）

1. 几个块的**盒子高度**一样吗？不一样 → 用 `align-items: stretch` + 各自内部 `center`。
2. 每一层容器都自己居中了吗？还是指望父级穿透？→ 层层嵌套。
3. 装 svg 的格子有 `line-height: 0` 吗？
4. 需要省略号的文字有没有被塞进 flex 容器直接写 `text-overflow`？→ 加内层 span + `min-width:0`。
5. 以上都对，仍差一点 → **截图量墨迹**，按量出来的差值加 `translateY(xx em)`。

## 反面清单

- ❌ 用 `height: 20px` / `line-height: 20px` 把几个块调成一样高（换字号就废）。
- ❌ 直接拍一个 `margin-top: 2px` 或 `position:relative; top:1px`，既没量过，又参与布局。
- ❌ 用 `vertical-align: middle` 去救一个已经是 flex item 的元素（对 flex item 无效）。
- ❌ 拿一个单独的 HTML 预览页定稿：字体栈、行高、主题变量都和真实页面不一样。
