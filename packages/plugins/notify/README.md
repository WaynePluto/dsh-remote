# @dsh-remote/dsh-plugin-notify

一轮跑完、agent 重新等你输入时，在**跑 dsh 的那台 Windows 机器**上弹一条常驻系统通知。

起因是 pi coding agent 那边有个 `notify` 扩展（`D:\dev\custom-skill\extensions\notify.ts`）：
它挂在 `agent_settled` 上，发一条 `scenario=reminder` 的 toast。dsh 一点这类能力都没有
（事实链见 [docs/02-dsh-facts.md](../../../docs/02-dsh-facts.md) §12.1），所以这个插件是从零加的。

## 它在什么时候响

| 时刻 | dsh 里的挂点 | 开关 |
|---|---|---|
| agent 真的停下来等输入 | `agent/status → idle` | 「一轮跑完时通知我」 |
| 审批卡片 / 提问悬了几秒没人管 | `approval/request`、`user-questions/request` 两个瀑布 | 「有东西在等我回答时也通知我」 |

两个开关都在**设置 → 通知**，**默认都开着**，存在设置命名空间 `dsh-plugin-notify`。

标题是 `DSH · <项目目录名> · <会话标题>`，正文按结局分：
已完成 / 失败（带失败码）/ 被停止 / 被拦下 / 到达长度上限。

## 三条不显然的设计

**不用 `turn/end` 当完成信号。** 一轮结束时 inbox 里还有消息就会立刻再开一轮，
用 `turn/end` 会让一次「用户视角的任务」响好几次。`agent/status → idle` 才是
「没有 driver 在跑也没有排队的活」，也正是 pi 的 `agent_settled` 的对应物。

**完成通知要去抖，等待通知要延迟。** `kick()` 会在设完 idle 相位的下一行同步地
再唤醒 driver（`agent.ts:226-230`），不去抖就会宣布一件还在进行的工作结束了；
反过来，审批瀑布并不代表「屏幕上出现了卡片」——权限预设自己就能决定的调用也会走一遍。
判断「真的落到人身上了」的办法是**看它悬了多久**（3 秒），不是看事件本身。

**通知文案走环境变量，不插进 PowerShell 脚本里。** 会话标题是模型写的、工具名是别人
注册的。传环境变量能让脚本变成一个**常量**：没有转义函数可以写错，`CreateTextNode`
又把 XML 转义包了。（pi 那份是插值 + 单引号翻倍。）

## 已知的坑

⚠️ **Windows toast 会静默失败。** 未注册 AUMID 的 AppID 可以被 API 接受却什么都不显示，
宿主侧观察不到。本机实测自定义 AppID 与 PowerShell 的 AUMID 都能弹，但这不是契约——
所以设置页有一个「发一条测试通知」按钮，那是唯一诚实的验证方式。什么都没出现时先看
「专注助手」，再看 Windows 通知设置里有没有 “DeepSeek Harness”。

⚠️ **通知弹在被控机上，不在浏览器里。** 从手机或异地电脑打开页面不会把通知带过去。
非 Windows 机器上整个插件是个 no-op（刻意不做 pi 那种 OSC 777 降级：dsh 的 stdout 是
一份日志文件，往里写终端转义序列既不产生通知也读不懂）。

## 设置页左侧那个铃铛

dsh 的设置导航图标是**写死的**（`SettingsRoot.tsx` 的 `navIcon` 只认 `models` /
`agent-presets` / `plugins`），`settings.section` 也没有图标位，未知 id 一律落到齿轮
（docs/02 §8.7）。所以铃铛是照 proxy 那个地球的做法**从外面画上去的**：
只往自己那一行写一个 `data-` 属性 + 一张样式表，不碰 React 渲染出来的节点。

**dsh 的图标集里没有铃铛。** 最近的是 `IconAlarmClockOutline16`，但它是错的词——
dsh 本身有 Schedule 子系统，闹钟会被读成「定时任务」。所以按 dsh 自己的描边语汇重画了一个：
16×16、`stroke-width 1.25`、圆头圆角，和闹钟 / 地球 / 齿轮同一套。

⚠️ **尺寸是这里唯一栽过跟头的地方。** 路径跨度 x 2.25–13.75、y 2–13.875，是**刻意**取到和
`IconAlarmClockOutline16`（x 1.75–14.25）一样满的。第一版只有 x 3.5–12.5，单看没问题，
一放进导航列、和 dsh 自己的图标并排就明显小一圈——**这种毛病只有在真实的行里挨着邻居才看得出来**。

⚠️ 这条是**显式**耦合到 dsh 的 DOM 的：按 CSS Module 的局部类名后缀命中（`_navCell` /
`_navLabel`）。dsh 一改名，这一行就安静地退回齿轮——降级，不会坏。升级 dsh 后复核一次。

## 验证

```powershell
pnpm --filter @dsh-remote/dsh-plugin-notify test       # 58 项单元测试
node scripts/notify-check.mjs                          # 真机冒烟，会真的弹一条通知
```

冒烟脚本起一个独立 DSH_HOME 的真 dsh，验证：全部 `--patch` 正常启动（两个瀑布监听与
设置命名空间都被接受）、`__DSH_BOOT__` 有本插件行、combo bundle 200 且带槽注册、
设置命名空间可写、`/notify/test` 带 cookie 通、不带 401、未知端点被通道自己挡下。
