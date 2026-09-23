# 插件第三方化与组合分发

功能插件不再是 launcher 反复“补回”的受管 Bundle。它们是 dsh-remote 随发行版提供、
首次默认安装的第三方插件：继续由 dsh 官方插件管理器展示、停用和卸载，dsh-remote 只负责
首次提供、配套升级和安装介质。决策见 [01-decisions](01-decisions.md) D20。

代码完成不等于验收完成；自动检查与实机项目分别列在文末。

## 当前分发形态

根目录 `plugin-catalog.json` 是分发包、组件、稳定行 ID、源码目录与默认层序的唯一权威清单。
22 个功能组件分为 4 个组合包与 7 个独立包：

| 分发 Bundle | 类型 | 组件 |
|---|---|---|
| `remote-experience` | 组合 | remote-settings、browser-compat |
| `model-enhancements` | 组合 | copilot-auth、models-catalog、model-capabilities、favorite-models |
| `conversation-enhancements` | 组合 | turn-retry、exec-process、chat-scroll、user-message-fork、notify |
| `development-tools` | 组合 | services、terminal、tools-inspector、skills-inspector |
| `directory-picker-browse` | 独立 | 网页目录选择 |
| `proxy` | 独立 | 出网代理 |
| `concise-mode` | 独立 | 简洁模式 |
| `agents-md` | 独立 | 全局提示词 |
| `files` | 独立 | 文件浏览 |
| `subagent-depth` | 独立 | 子代理深度 |
| `yolo-mode` | 独立 | 固定 YOLO |

完整包名为 `@dsh-remote/dsh-plugin-<名称>`。组合包的 `cordis.patch.yml` 通过固定版本依赖
装载组件，每个组件仍有稳定且全局唯一的行 ID。组合包是安装、卸载与配套升级单位；组件行
保留单独停用能力，但有两个例外：models-catalog 与 model-capabilities 共同参与
`llm-pi-ai` 启动屏障，当前不能只关闭其中一行。整个 model-enhancements 仍可停用或卸载。

directory-picker-browse 必须在 Bundle 层静态停用 dsh 原生目录选择器，无法作为组合包中
可独立停用的普通行，因此单独分发。不要同时启用组合包和其组件的旧独立 Bundle，否则相同
稳定 ID 会产生重复入口冲突。

## 生命周期

1. `dsh-remote-web` profile 初始只包含 `dsh-base` 与 `dsh-web-app`。
2. 某个分发包首次被提供时，launcher 通过 dsh 官方插件管理器安装并默认启用。
3. 后续 dsh-remote 启动会把当前介质版本配套升级到所有仍在 profile dependencies 中的包，
   包括已停用的 Bundle；升级保持 `dsh.profile.bundles` 的选择及 profile patch 中组件行的
   `disabled` 状态。
4. 用户卸载 Bundle 后，其 dependency 消失。状态文件会记住它已提供过，launcher 不再安装，
   托盘和 CLI 也不提供旧的“补回 Bundle”语义。
5. 需要恢复时，在 dsh「添加插件」中输入当前介质内目标包目录的绝对路径，安装完成后启用：
   - 绿色发行版：`<解压目录>/plugins/<包目录>`
   - 源码开发：`<仓库>/.dev/plugins/<包目录>`

重新安装得到当前 dsh-remote 随附版本，而不是从旧 profile 或网络猜测版本。介质目录中的
`catalog.json` 记录 11 个包及组件；删除 profile 依赖不会删除介质文件。

## 旧 profile 迁移

旧版 profile 中 22 个受管 Bundle 在首次运行新生命周期时迁移为 11 个第三方分发包：

- 仍安装或启用的组件归入对应组合/独立包；旧组件 dependency 在组合包安装后移除。
- 旧 Bundle 已停用的组件会在 profile patch 中写为同 ID 的 disabled 行，保持用户选择。
- 旧版已经明确卸载的 files 保持卸载，不因迁移重新出现。
- 迁移后 `dsh-remote-bundles-state.json` 使用新版状态记录已提供包及介质版本；它只辅助区分
  “首次提供”和“用户已卸载”，不代替 profile dependency 这一安装事实。

## 开发与发行介质

`scripts/plugin-distributions.mjs` 按同一清单原子生成可搬移介质，检查 Bundle patch、宿主产物、
浏览器产物与组合包组件闭包，并去除 `workspace:` 协议。组合包把组件复制进自己的
`node_modules/@dsh-remote/`，无需在线获取本仓库私有包。

- `pnpm run dev` 先构建功能插件，再自动生成 `.dev/plugins/`，并在仓库同级准备按依赖指纹
  隔离的 dsh 运行时。隔离运行时没有工作区同名安装锚，避免源码 `node_modules` 遮蔽真正安装到
  profile 的第三方包；随后开发栈执行与发行版相同的生命周期。介质及运行时依赖先复制到 profile
  内同盘缓存，避免 Windows 跨盘 `link:` 静默缺失；原生插件页收到 `.dev/plugins` 绝对路径时，
  launcher 的 pnpm 代理也会按包名映射到该缓存。旧 pnpm 主版本创建的依赖目录会安全重建。
- 绿色打包在每个平台/变体的根目录生成 `plugins/`，并把它放入 zip。功能插件不再依靠
  launcher 的 production dependency 充当安装锚；介质生成与打包检查覆盖离线内容、依赖闭包、
  路径含空格/中文及宿主/浏览器产物。

开发与发行只允许介质目录和 dsh 安装锚不同，生命周期逻辑必须共用。`pnpm start` 直接运行已有
构建产物，不替代 `pnpm run dev` 的插件构建、介质生成与隔离运行时准备步骤。

## 壳级运行时 overlay

`@dsh-remote/dsh-plugin-remote-privileged` 由 launcher 以 `--patch` 常驻装载，不是功能插件，
不进入第三方安装、升级、停用或卸载生命周期。它保留 connection 的 webRuntime/webServer 注入，
并固定 `llm-pi-ai` 的模型启动屏障；模型增强未随进程启动时提供占位屏障，已启动时由模型组件
完成真实初始化后把屏障挂在 root fiber。这样运行中停用或重新启用模型 Bundle 不会热重启
`llm-pi-ai`。remote-settings 已属于 remote-experience 组合包，可在其中单独停用。

## 子代理深度配置

subagent-depth 的设置入口已从官方卡片槽 `plugins.item` 迁到按包名 keyed 的
`plugins.bundle.config`。表单只在该 Bundle 详情页的 `view: 'page'` 渲染，直接使用页面已有的
标题、说明和配置区域，不再绘制第二张嵌套卡片或重复折叠标题；写入仍遵循 mutate 后回读、失败
保留草稿的规则。

## 尚待验证

以下项目未完成前，不得把 roadmap 的实机验收勾为完成：

- 跑完受影响包测试、launcher/pack 测试以及仓库级 `check:dependencies`、lint、typecheck、build、test。
- 在真实 dsh 插件页验证 4 个组合包与 7 个独立包首次安装、Bundle 停用、允许的组件停用、卸载、
  launcher 重启不补回，以及从 `plugins/` 绝对路径重装当前版本。
- 验证升级一个已启用 Bundle、一个已停用 Bundle 和一个含停用组件的组合包，三者版本更新而状态不变。
- 验证 model-enhancements 整体停用可用；当前界面仍会显示两个启动屏障组件的行开关，实机验收不得单独关闭它们。
- 验证 user-message-fork 与 files 的 priority shadow 在新层序下生效。
- 在深浅主题和中英文界面检查组合包组件行、subagent-depth 无嵌套卡配置页及全部浏览器入口。
- 在绿色包与 `pnpm run dev` 各走一次卸载后重装，覆盖离线、空格和中文路径。

## 后续发布边界

当前安装介质随绿色包交付，不代表这些私有包已经发布到 npm。若以后公开发布，仍需先确定
semver/changelog、`@dsh-remote` scope、dsh peer/dependency 策略和 CI；无需为了发布拆仓。
connection overlay 始终留在壳内，不改成用户配置项。
