# @dsh-remote/dsh-plugin-skills-inspector

在 dsh 会话头部的视图切换栏里加一个「技能」tab：当前会话有哪些技能、来自哪一层
（全局 / 项目 / 内置）、agent 已经加载了哪些、点开能看到并打开它的本地文件。

## 为什么需要它

dsh 把技能目录**只发给模型**（`<available_skills>` 那段 system-reminder，
`tool-skill/src/index.ts:254`）。页面上没有任何地方能看到会话里有哪些技能、
它们来自哪一层、agent 到底加载过哪些。

## 它回答的四个问题

| 问题 | 怎么答 |
|---|---|
| 这个会话有哪些技能 | `ctx.skills.snapshot({ cwd, scope: agent })` |
| 全局还是项目级 | `SkillSummary.source` 分组显示（**dsh 的权威答案，不是猜的**） |
| agent 已加载了哪些 | 回放会话日志的两条加载路径，覆盖整个会话历史 |
| 本地文件在哪 | 点开某行时 `skills.get(name)` 取精确 `SKILL.md` 路径 |

完整证据链在 **docs/02 §16**。

## ⚠️ 三个只有读源码才知道的坑

### 1. scope 必须传 `ctx.agents.get(sessionId)`（与 tools-inspector 同一个坑）

技能 provider 由 agent preset 挂在**每会话 scope** 下。不传 scope 只读得到全局层 ——
实测对一个没有活 agent 的会话查询，**技能数为 0**，项目的 `.agents/skills` 一个都看不到。
`cwd` 同样不能省：项目级技能根由它解析。

### 2. `list()` 拿不到文件路径，只有 `get()` 有

`toSummary()` 只抄 7 个字段，`path` **不在其中**。`SkillSummary` 上只有
`resourceBase`（技能**目录**）。精确的 `SKILL.md` 要 `skills.get()`，
而那会**连带把整个正文读进内存** —— 所以本插件把它拆成独立的 `locate` 端点，
只在用户点开某一行时调一次，绝不在列表里批量取。

### 3. `tool/call.arguments` 是模型原样产出的**未解析字符串**

dsh 的注释原话：「the raw `arguments` JSON string exactly as the model produced it
(unparsed)」。所以取技能名必须把 `JSON.parse` 包在 try 里 ——
一条畸形的历史记录不该让整个 tab 崩成错误页。单测里有专门的用例钉住这条。

## 「已加载」的口径

**技能正文已注入本会话上下文**，统计覆盖**整个会话历史**（回放会话日志得出），
dsh 重启后依然准确。两条加载路径都记，并区分是谁发起的：

| 显示 | 来源事件 |
|---|---|
| `模型` | `tool/call`，`name === 'skill'` |
| `用户` | `user/message`，`source.kind === 'skill-invocation'` |

三条判定规则：

- **加载失败的不算**（配对的 `tool/result` 带 `error`）：正文从未进入上下文；
- **尚未配对的算**（正在进行的这一轮）：否则刚加载完的技能会闪一下才出现；
- **用户路径没有失败一说**：注入发生在 `agent/pre-step`，注入了就是进了上下文。

> 为什么不是「当前上下文里仍然在场」：dsh 会压缩历史，那个口径既算不准，
> 也会随时间悄悄变化。页脚如实写明了当前口径。

## 它是只读观察窗口

不注册技能、不注册技能来源、不注册工具、不 `restrict`、不 `guard` ——
对 agent 行为**零影响**。`scripts/skills-inspector-check.mjs` 显式断言这几条。

**刻意没有「加载」按钮**：那会让这个 tab 从观察窗口变成能改变会话的控件，
与 tools-inspector 建立的只读约定不一致。要加载技能，让 agent 去加载，
或自己在输入框敲 `/技能名`（页脚有这句提示）。

## 界面

一屏一列表，与「工具」tab 共用同一套视觉语言（13px、`●`/`○` 字形状态、
分组细线、等宽名字列）。

```
14 个技能 · 3 个已加载                          [搜索        ]
─────────────────────────────────────────────────────────────
已加载进本会话 ──────────────────────────────────────────────
● dsh-source        定位并查证 dsh 的本地源码与官方文档    模型
● git-commit        创建符合规范的 Git commit              用户
项目 .agents/skills ─────────────────────────────────────────
○ relay-audit       查证 relay 的安全活动记录
全局 DSH_HOME/skills ────────────────────────────────────────
○ frontend-design   Guidance for distinctive visual design
内置 dsh 自带 ───────────────────────────────────────────────
○ cordis-plugin-development  Create, modify, debug ...
```

- **「已加载」独立成第一组**，按最近加载倒序：用户切进来的第一个问题就是它。
- **未加载的按来源分组**：「全局还是项目级」用组标题回答，比每行挂 badge 干净；
  标题是「中文人话 + 灰色真实路径」，一次讲完概念与磁盘位置。
- **状态靠字形不靠颜色**：深色主题下颜色容易翻车（docs/02 §8.6）。
- **点一行展开**：何时使用、来源、本地文件路径。

## ⚠️ 「在本机打开」为什么是条件显示

`session.openWorkspacePath` 打开的是**宿主机**的桌面 —— 对本项目的主场景
（手机远程）完全不可见。所以先用 dsh 自己的 `canOpenWorkspacePath()` 探测，
能开才显示按钮；**任何情况下路径本身都以等宽小字显示且可选中复制**。
否则就是做了一个在手机上点了没反应的按钮。

打开动作走 dsh **自己的** Remote，不自己 spawn —— 自己 spawn 就绕过了沙箱，
而这件事 dsh 已经做好了。

## 座位

`conversation.view`，list 槽，`order: 30`（dsh 自己：chat = 0、trajectory = 10；
本仓库 tools-inspector = 20）。范本是 dsh 自己的 `ui-trajectory`。
**没有改 dsh 任何源码。**

⚠️ `label` 必须传 **thunk**：传字符串会把注册时的语言钉死，切语言后 tab 文字不变。

## 验证

```powershell
pnpm --filter @dsh-remote/dsh-plugin-skills-inspector test        # 纯函数（27 项）
pnpm --filter @dsh-remote/dsh-plugin-skills-inspector typecheck   # 两半各一个 program
node scripts/skills-inspector-check.mjs                           # 真机冒烟（42 项）
```

冒烟脚本里有一段**直接对着真的技能注册表**验 `list()` 无 `path` / `get()` 有 `path`
的链路 —— 那条链路一旦被上游改掉，页面会安静地退化成「这个技能没有本地文件」，
单元测试和 HTTP 冒烟都看不出来。

⚠️ **改完插件必须重启 dsh，刷新页面没用**：`dsh-remote-web` profile 里没有挂 hmr 行
（docs/02 §13.7）。
