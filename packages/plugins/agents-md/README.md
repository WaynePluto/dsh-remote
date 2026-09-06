# @dsh-remote/dsh-plugin-agents-md

**设置 → 全局提示词**：在页面里查看和编辑 `$DSH_HOME/AGENTS.md`。

## 为什么需要它

dsh 本来就会把**用户级全局提示词**读进每一个会话 —— `agent-instructions` 在
`packages/context/agent-instructions/src/files.ts:280` 把 `<dshHome>/AGENTS.md` join 出来，
排在所有项目级 `AGENTS.md` 之前推给模型。

但 **dsh 没有给这个文件提供任何界面**。它真实存在、真实影响每一次对话，而唯一的编辑方式
是「你得先知道它存在」，然后用文本编辑器打开它。对于通过 relay 从手机指挥这台机器的人，
这件事根本做不到。

本插件只补这一件事：给那个文件加一个编辑器。

## 它刻意不做的事

- **不改 dsh 读取提示词的任何行为**，也**不注册自己的 `agent-instructions` 行**。
  dsh 的加载器仍然是唯一的读取方，本插件只是往它读的那个文件里写字节。
- **不把正文存进设置命名空间**。存进去就会变成第二份、而且是 dsh 的加载器不读的那一份。
  本插件因此**没有设置命名空间**，它的状态就是那个文件本身。

## 为什么是全局唯一一份，而不是每个预设一份

`agent-instructions` 这一行其实位于**每个预设自己的 composition** 里
（`presets/standard/agent.cordis.yml:30`），所以它的 `dshHome` 理论上可以各不相同，
从而让每个预设拥有私有的提示词文件。

这条路**评估后被用户否决**：官方的 `standard` / `cordis` / `ptc` 是 `trust: 'system'`，
不允许修改，所以「每个预设一份」等于逼着人把每个想用的预设都复制一份成用户预设。
最终选择是**全局唯一一份**，就是 dsh 本来就在读的那一个文件。

## 结构

| 位置 | 作用 |
|---|---|
| `src/shared.ts` | 两半共用的通道名、端点名、大小上限与**同一个校验函数** |
| `src/file.ts` | 读写 `<dshHome>/AGENTS.md`；路径经 dsh 自己的 `resolveDshHome` |
| `src/index.ts` | 宿主半：`/agents-md` 的 `load` / `save` 两个端点 |
| `src/client/` | 浏览器半：设置页、文案、导航图标 |

## 几条不能破的规则

- ⚠️ **`MAX_BYTES` 不是本插件发明的限制**。dsh 的加载器拒绝读取超过 `maxSourceBytes`
  （默认 1 MiB）的提示词文件，而且是**静默丢弃**。如果不在保存时拦下来，用户会看到
  「已保存」，模型却永远收不到。两半用 `shared.ts` 里**同一个** `documentFault()` 判断，
  所以页面接受的内容不可能被宿主拒绝（这正是 docs/02 §8.8 那个坑的形状）。
- ⚠️ **UTF-8 字节数，不是字符数**。60 万个汉字的字符数远小于上限、字节数远超上限。
- ⚠️ **保存必须是原子的**：先写临时文件再 `rename`。半个提示词文件会被当成用户写的
  内容原样喂给模型。
- ⚠️ **失败时绝不丢草稿**。这个仓库已经在设置页上吃过两次这个亏（docs/02 §8.8）。
- ⚠️ **端点在 URL 路径里**：浏览器 POST 到 `/agents-md/load`，信封里的 `method`
  必须和最后一段一致（docs/02 §10.8）。
- ⚠️ **导航图标是画上去的**，因为 `settings.section` 没有图标位（docs/02 §8.7）。
  尺寸对齐 dsh 自带图标的跨度；升级 dsh 后若类名变了，只会退回齿轮。

## 验证

```powershell
pnpm --filter @dsh-remote/dsh-plugin-agents-md test        # 16 项单元测试
node scripts/agents-md-check.mjs                            # 真机冒烟，17 项
```

冒烟脚本里最重要的一条，**是单元测试锁不住的**：它写入一段带唯一标记的文字之后，
调用 **dsh 自己的** `discoverBaselineInstructionFiles()`，确认 dsh 把这个文件算进了基线。
因为 `USER_GLOBAL_FILE` 定义在 dsh 内部的 `render.ts`、**不在公开入口上**，我们只能抄一份
常量 —— 而单元测试只能验证「我们和我们自己抄的那份一致」。这条反向验证是唯一能证明
**「写对了地方」** 的办法。dsh 一旦改名或挪位置，这条会立刻变红，而不是让用户在
「页面说保存了、模型收不到」之间困惑。

**升级 dsh 后必须跑一次这个脚本。**
