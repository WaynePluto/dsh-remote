# 插件机制与界面

基线见 [源码依据](../02-dsh-facts.md)。产品装载规则见 [决策](../01-decisions.md)。
以下路径相对 dsh 仓库根，明确标注项目实现的除外。

## Bundle 与 Overlay

出处：`apps/cli/src/profile-boot.ts`、`packages/boot/app-boot/src/index.ts`、`src/profile.ts`。

应用顺序为 Bundle → profile patch → home patch → --patch（argv 顺序），后者覆盖前者。
--patch 可重复传入；insert 中 ./ 或 ../ 开头的入口锚定到 patch 所在目录。
裸包名则相对 profile 解析，因此依赖其他宿主包的插件应声明 dependencies，由自身模块解析并挂载。

profile patch 执行时，末尾 overlay 插入的行还不存在，所以覆盖普通项目插件 config 需要更靠后的 patch，
且目标行必须有稳定 id。用户可编辑的配置通常应使用设置命名空间，不依赖 Cordis config。
插件配置页编辑的是 settings.plugin.item 对应的 namespace，不直接编辑 Cordis entry config。

## 精简预设 Bundle

出处：`packages/bundle/web-app/cordis.patch.yml`、`packages/preset/agent-presets/src/{preset,discovery}.ts`、
`packages/preset/persona/src/index.ts`、`packages/core/agent-tool-presentation/src/index.ts`、
`packages/core/system-prompt/src/index.ts`。

dsh-web-app 创建 agent-presets 行，因此 concise-mode Bundle 必须排在其后，向同一 profile 增加 preset root。
root 经 path.resolve 处理，不能直接用相对路径；包内 locator 从 import.meta.url 算出可搬移的绝对目录。
较早 root 的同名 preset 胜出，官方 web profile 不添加这个 root。

两个预设保留文件、搜索、技能、前台 shell、前台一次性子代理、用户提问、待办和压缩。
shell 与 subagent 的 enableRunInBackground 为 false，subagent 使用 one-shot。
profile 根层的 service_* 和 interactive_terminal 仍可继承。

- concise：complete:true、includeRuntimeContext:false，原生工具 schema。
- concise-ptc：complete:false、includeRuntimeContext:false，纯 ptc，模型协议只暴露 run_code。
- complete:true 会过滤 system-prompt section，连 tools:ptc-only 与 tools:sdk 一起过滤，不能用于纯 PTC 预设。
- PTC SDK、提示词、并发、worker、子调用日志均由 dsh 提供，不复制实现。
- PTC 内部调用记录 tool/ptc-dispatch，项目统计只使用顶层 tool/call。

## 客户端产物

出处：`packages/client/modules/src/index.ts`、`packages/client/tsdown.client.ts`、`packages/client/web/src/platform.ts`。

客户端扫描会从 --patch 的入口向上寻找 package.json，读取 dsh.client 与 exports["./client"]。
浏览器 bundle 使用 lazy CJS factory，由 window.__ModuleLoader__.load 注册，必须匹配页面模块表。
React、Cordis、store、slots、ui-primitives 等共享运行时保持 external，其他依赖按需内联。
跨插件通过 Cordis 服务协作，避免重复打包造成模块实例不一致。

缺失 dist/client.js 会导致客户端模块激活失败，可能使整个 Web UI 无法启动。
launcher、开发栈和打包脚本必须同时检查宿主与浏览器产物。

注册时 readFileSync 将 bundle 读成不可变快照，以 IMMUTABLE_CACHE 下发；只有 rebuilt() 会重读，
该回调由 HMR watch 触发。dsh-remote-web 没有 HMR，任何插件改动都必须构建并重启 dsh。

## index.html 注入

出处：`packages/host/webserver/src/index.ts`（`webserver/index-inject` 事件）、`src/injections.ts`。

宿主插件订阅 `webserver/index-inject`，向每次渲染重新收集的表追加结构化行；行是纯
JSON 数据，serve 形态渲染进 index.html 文本，静态 worker 形态由 boot payload 的页面解释器
按同一顺序执行。行类型：`global`（先于后续 script 行给 globalThis 赋值）、`script`
（内联经典脚本，text 不得含 `</script`）、`script-src`/`script-preload`、`style`、`html`。

head 位置的经典脚本 parser-blocking，先于页面 combo 模块求值。remote-privileged 用
global 行注入 `__DSH_TRANSPORT__`；browser-compat 用 head script 行在旧 WebKit 上垫平
Iterator/AbortSignal/Promise 能力，并建立当前页面内存中的诊断桥（函数体 `toString()` 序列化，
必须自包含、不引用模块作用域）。client 半读取该桥显示临时日志，不向 Host 发 RPC。

## 设置写入

出处：`packages/settings/settings/src/index.ts`、`packages/client/ui-settings/src/client/settings-scope.ts`。

宿主支持 get/update/replace/mutate，mutate 使用 set/unset 路径操作，只改所属字段。
namespace 统一为 dsh-plugin-<名字>，全局提示词正文直接保存文件，不放入 settings。

浏览器 SettingsScope.mutate 在宿主拒绝写入时会 recover 并正常 resolve，不是 reject。
因此必须：

1. 保存前用宿主与浏览器共享的纯函数校验。
2. await mutate 后读 getSnapshot().value，核对实际落地值。
3. 未落地时报错并保留草稿，只有确认成功才清草稿和显示已保存。
4. 错误贴近字段，成功提交触发的刷新不能立即抹掉成功提示。

## 槽位与导航

出处：`packages/client/ui-slots/src/index.ts`、`packages/client/ui-settings-models/src/client/slot-contract.ts`、
`packages/client/ui-conversation/src/client/contract/slots.ts`。

- keyed/single/list 槽同一 cell 可以按 priority 影子覆盖，数值最小者渲染；同 cell + 同 priority 才冲突。
- 接管现有 renderer 使用 priority:-1；并列添加用 list 或插件定义的子槽。
- `ctx.slots.onEntryError` 观察被错误边界捕获的 slot renderer 异常；它只覆盖渲染边界，不等于全局
  `window.error` 或 Promise 拒绝监听。监听器随插件 fiber 清理，来源为 `packages/client/ui-renderer/src/client/registry.ts`。
- settings.models.provider-card 是 keyed，llm-pi-ai 的入口由 copilot-auth 负责组合。
  model-capabilities 使用其项目子槽，models-catalog 使用 settings.models.footer。
- conversation.view 是 session-scoped list，label 必须是 thunk，才能随语言切换。
- conversation.chat.node 是 keyed；新增消息行需要自己的 ConversationNodeDefinition 和新 key。
- conversation.input.dock 是输入框上方的 list；conversation.composer.dock 在下方。
- conversation.chat.turnTail 是 chain，不适合保证多个插件并列显示。

settings.section 没有 icon 字段，导航 shell 按 id 选择图标，未知 id 为齿轮。
出处：`packages/client/ui-settings-general/src/client/SettingsRoot.tsx`。
项目的代理、通知、全局提示词和浏览器日志使用局部导航标记和注入样式，不替换 React 节点。
当前图标映射为 `IconGlobeOutline14`、`IconAlarmClockOutline16`、`IconListPenOutline16` 和
`IconCodeOutline16`；`settings.section` 没有 icon 字段，因此插件调用这些原生 component 并将
返回的 SVG element 序列化成导航 mask。
公共 helper 使用 dsh shell 已渲染的直接子 SVG 作为 mask 载体，并隐藏其原生子路径，避免伪元素在
React 重建或旧 WebKit flex 布局中丢失。升级检查包含 `navCell`/`navLabel` 的局部类名；不匹配时退回默认图标。

### 右侧 Sidebar 页面类型

出处：`packages/client/ui-sidebar-right/src/client/tab-registry.ts`、`contract/slots.ts`、`service.ts`，
文件树实例见 `packages/client/ui-sidebar-files/src/client/{definition,index,FilesBody}.ts`。

- 页面类型通过 `ctx.sidebarRightTabs.register({ id, kind, priority, title, guide })` 注册；不声明 `patterns` 的类型是页面，入口由 guide box 的 `order/title/description/icon` 提供。
- 页面正文必须以同一 `id` 注册 keyed slot `sidebar.right.pane.tab`；组件通过标准 props 的 `useTabInfo()` 读取当前 tab 与 `tab.actions`，并由 session scope 自动得到 `sessionId`。
- `ctx.sidebarRight.openTab(kind)` 打开页面；条目内部应使用 `tab.actions.openTab/openResource`，不要自己拼 `sidebar://` 地址。files 增强只 shadow 原生 `files` body，不另注册用户可见 kind；其他外部插件仍使用独立 kind，只有明确接管 builtin kind 时才用 `priority: 'extension'` 同 kind 注册。
- 页面包的 `package.json` 用 `dsh.client.inject` 声明对 `@deepseek-ai/dsh-client-ui-sidebar-right` 的模块关系；Cordis 运行时仍把 `sidebarRightTabs` 放进插件 `inject`，两者不是同一种依赖。

### 原生文件增强的复用边界

出处：`packages/client/ui-sidebar-right/src/client/{tab-registry.ts,service.ts,contract/slots.ts}`、
`packages/client/ui-renderer/src/client/registry.ts`、`packages/client/ui-slots/src/index.ts`、
`packages/client/web/src/platform.ts`。文件能力见 [工作区](workspace.md)。

- 同 kind 共存只允许一组 builtin + extension；原生 `files` 可以这样接管，guide 只列生效项，
  卸载 extension 后恢复 builtin。`text` 属于 fallback，不能用 extension 同 kind 重注册，二者会冲突。
- `ctx.sidebarRight.split(paneId)` 返回新 pane id 或 undefined；底层 dockkit 默认预算为四个 docked pane，
  当前 Sidebar controller 的 split 还在已有两个 docked pane 时拒绝分栏，并受空间与浮动状态约束。
  `tab.actions.openResource(address, { paneId })` 可指定目标 pane，但分栏本身不会改变原生树“在自己的 pane 打开文件”的行为。
- `FilesBody` 与 `TextPreview` 没有从各包 client 入口导出为运行时值，两包也不在平台共享模块表；
  不能仅添加 external 就假定浏览器能 import 它们。发布 files 列表也不包含源码，不能依赖 `./src/*` 导入。
- `slots.entries` 是登记快照，不是通用组件嵌入 API；files 增强在当前版本只把它作为版本受控的适配 seam：
  shadow 登记完整复用原 entry 的 component、store、inject、locale，并只在外层观察/事件委托。
  这不是对任意 dsh 组件的稳定承诺，原生登记契约变化必须由冒烟检查响亮失败。
- Slot 的子槽由唯一登记 owner 声明并持有 render 授权；对现有 cell 加 priority:-1 不会继承原登记项的 children。
  files 不重声明 `sidebar.right.tab.document`，不覆盖 `ui-sidebar-documentpreview` owner；ctx 级 renderSlot 只能渲染 root。
  因此不能把原生预览拆出来任意嵌入另一个 body。图片增强改在原生 text title slot 以 portal 控件定位已渲染 image frame，
  不复制 ImageBody 或通过 root 重新声明 document child slot。portal 内的交互控件必须同时阻止
  `pointerdown` 和 `click` 冒泡；dockkit 的原生 tab 会在 pointerdown 启动拖动/重建，若不阻止，浏览器可能把
  portal 按钮的后续 click 重定向到 tab。该行为与 `ui-dockkit` 的 TabMenu 处理一致，files 的图片工具栏遵循同一规则。

### 临时预览页签的可用接口

出处：`packages/client/ui-sidebar-right/src/client/{service.ts,tab-domain.ts,stores.ts,contract/slots.ts}`、
`packages/client/ui-sidebar-documentpreview/src/client/TextTitle.tsx`。
以下为当前基线源码事实，尚不表示项目 files 已实现临时页签。

- 原生没有临时/保留页签标志。`sidebar.right.pane.tab.title` keyed 槽可扩展标题，
  `useTabInfo()` 提供 tab id、panel id、navigation、actions、signal；原生 TextTitle 提供文件图标和名称。
- `ctx.sidebarRight.openResource(address, { replaceTab: tabId })` 可替换指定页签；tab 自身的
  `actions.openResource(address, { replaceTab: true })` 替换的是调用者自己，不能在文件树 tab 上直接调用后者。
- 替换是一次原子布局操作：借用旧 docked tab 的 pane 和 strip 位置，打开新 occurrence，再关闭旧 occurrence；
  不保证 tabId 不变。关闭会 abort 旧 signal，正文读取状态仍归原生预览管理，不手改 contentId。
- 原生资源按 `(kind, contentId)` 跨 pane 去重，默认 `revealIfOpened:true`。命中既有 tab 时也会关闭
  `replaceTab` 指定的另一 tab；因此“聚焦已打开文件”不应盲目附带 replaceTab。
- `openResource` 返回 void，没有公开的新 tabId 回调；增强需通过标题槽的 live 信息确认落点，不能猜 id
  或私读布局 store。tab signal 仅在 tab 消失/宿主插件卸载时 abort，切换 tab/会话或 body 卸载不等于关闭。
- 浮动 tab 的替换不继承浮动位置。移动/浮动后的临时页签需要明确策略，不能继续按旧 pane 关联替换。

### Sidebar 首次打开的默认页

出处：`packages/client/ui-sidebar-right/src/client/contract/seed.ts`、`tabs/guide/GuideBody.tsx`（同包 client 下）。

- `defaultSeed` 在仅有一个 guide 入口时直接选择该入口的页面 kind；零个或多个入口时选择 `guide`。
  因此将 files-pro 与 files 合并成唯一入口，可能改变空布局首次展开的页面，不代表入口登记本身丢失。
- guide 中选择入口通过该 guide tab 的 `actions.openTab(kind, { replaceTab:true })` 替换 guide 自身。
- 用户报告的首次展开目录入口消失仍待真实复现；需区分上述单入口默认页、树 tab 被错误替换、已有布局恢复。
  不能以源码候选直接认定现场原因，也不能以增加重复/虚假入口修复。项目修复方案见根目录开发计划。

### 页签右键菜单与关闭范围

出处：`packages/client/ui-dockkit/src/components/{TabPanel.tsx,TabMenu.tsx}`、
`packages/client/ui-sidebar-right/src/client/{contract/slots.ts,stores.ts,shell/SidebarRight.tsx}`。

- 原生 TabMenu 提供关闭项，并在其后渲染 `sidebar.right.tab.menu.item` list 槽；该槽为 session scope，
  owner 提供右键目标 `tab` 与 `dismiss()`，没有 paneId 或分栏页签列表。动作必须自行 dismiss。
- 非激活页签的右键不会先激活它，故批量关闭必须以右键目标所在 pane 为准，不能使用 active pane 代替。
  `data-dockkit-pane`、`data-dockkit-tab` 可用于当前版本只读、局部归属核验，不是稳定的布局查询 API。
- 原生关闭拒绝不存在的 tab，并保护唯一 docked guide；关闭最后一个非 guide docked tab 会收起 Sidebar。
  增强应沿用关闭入口及布局规则，不直接删布局记录或循环清除新出现的默认页。
- 项目「关闭其他/关闭全部」仍为待实施方案：固定当前分栏 tabId 快照并逐项核对存活/归属，不越过分栏或会话边界。

## 主题与对齐

出处：`packages/client/ui-theme/src/styles/design-platform.css`、
`packages/client/ui-primitives/src/icons/index.tsx`。

| 用途 | 正确 token 或规则 |
|---|---|
| 描边 | --dsw-alias-border-l1、--dsw-alias-border-l2，l 是字母 |
| 层背景 | --dsw-alias-bg-layer-2 |
| 文字 | --dsw-alias-label-primary、secondary、tertiary |
| 等宽 | var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace) |
| 抬升面 | --dsw-specific-tip |

浅色 bg-layer-1/2/3 都是白，bg-layer-4 无定义；内嵌容器不能只靠层背景表达边界。
--dsw-font-mono 虽被引用但未定义，必须提供完整字体栈。
token 拼写和实际值是两件事，需用真实页面 getComputedStyle 检查深浅主题。

图标与文字对齐先用嵌套 flex；外层 stretch，各块内部 align-items:center。
汉字墨迹中心与 SVG 几何中心仍可能相差约 1.5px，图标格可用 translateY(0.115em) 做光学补偿。
具体量法见 flex-centering skill；图标尺寸必须放入真实相邻导航行比较。

### 插件配置表单

出处：`packages/client/ui-settings-plugins/src/client/fields.module.css`、`fields.tsx`。
编写主题样式先加载项目 [dsh-theme skill](../../.agents/skills/dsh-theme/SKILL.md)，
其中包含级联、原生控件与深浅主题验证方法；新经验经验证后自动合并回技能。

- 字段使用 34px 内容高度、水平 12px padding、0.5px border-l4、8px 圆角、bg-layer-3，
  文字为 13px / 1.5 / label-primary；核对 content-box 与实际渲染高度，不能只抄 height。
- 内置字段 `:focus-visible` 取消 outline，只将原有边框改为 brand-primary，不叠加粗外圈。
  下拉触发按钮用 `:focus` 同时覆盖鼠标与键盘，`[aria-expanded='true']` 在菜单内获得焦点时保持边框色；
  不能移除轮廓后丢失可见焦点反馈。
- 默认与焦点/禁用态的 border、color 放在局部 CSS；inline border/color 会压过普通伪类规则。
  禁用态使用 label-tertiary、default cursor，同时保留原生 disabled 语义。
- `appearance:none` 不会自动移除 UA 焦点 outline，也不会统一 OS 原生 select 弹层的 hover。
  卡片 header 的 2px 键盘焦点圈不受字段规则影响。
- 设置 → 模型里的原生字段基准来自 `packages/client/ui-settings-models/src/client/ModelsSection.module.css`：
  `border-box`、32px、0.5px border-l4、8px、bg-layer-1、14px/22px、brand focus；select
  额外保留右侧 12px chevron。`model-capabilities` 的三个能力/协议 select 必须跟这个基准，
  不能退回 1px border-l1、透明背景或 UA focus。
- 设置 → 代理与全局提示词是项目自有原生 input/textarea；它们也必须给出局部 focus/disabled
  状态，避免实际页面出现黑色 UA outline。编辑器的等宽字体、较大高度和 textarea 语义可以保留。
  日志/终端输出等 code surface 则是有意的阅读容器，不按表单字段强行改成同一高度；终端实际输入框仍按 dsh
  字段处理，不能因为同在一个 dock 就沿用输出区的 l1/transparent 样式。

### 选项菜单

出处：`packages/client/locale/src/client/LanguageRow.tsx`、`packages/client/ui-primitives/src/Menu.tsx`、
`Menu.module.css`。项目 subagent-depth 的 DepthSelect 复用与语言下拉相同的 external Menu。

- 选项 hover 使用 `--dsw-alias-interactive-bg-hover`，不要给原生 option 强套 CSS，或修改触发器背景来代替。
- 默认 `selection='check'` 以右侧勾号标记 `selectedId`，选中未 hover 时仍透明；`fill` 会常驻高亮，语义不同。
- 设置页使用 `portal` 避开滚动容器裁剪；Menu 的 `className` 仅给锚点 wrapper，不传给浮层。
- 当前 Menu 无选中项自动聚焦或方向键导航；替换原生 select 时由字段局部补齐箭头/Home/End、
  Enter/Space、Tab/Escape 和选择后焦点归还。外部点击关闭不抢焦点；禁用时关闭菜单并拒绝选择。
- Portal 首帧隐藏以测量尺寸；自动聚焦需等定位提交后（如可清理的下一帧），不能在同轮父 layout effect 中直接 focus。
- Portal 的 React 键盘事件仍到达字段 owner，局部 Escape 应阻止冒泡，避免同时关闭父设置窗口。

### Modal 弹窗

出处：`packages/client/ui-primitives/src/Modal.tsx`、`Modal.module.css`。

- 插件传给 Modal 的 `className` 落在 `.dialog` 卡片上：`position:relative`、`overflow:hidden`，
  Modal 不提供自定义 header 插槽；要在关闭按钮旁加自绘按钮，只能绝对定位在卡片内。
- header 布局：padding `22px 14px 12px 24px`，close 按钮 28×28、圆角 8、右侧 14px；
  紧贴其左侧的新按钮用 `top:22px; right:50px`（14+28+8），样式复刻 `.close`：
  transparent 背景、`--dsw-alias-label-secondary`、hover `--dsw-alias-interactive-bg-hover`，保留 UA 焦点轮廓。
- 自绘按钮必须压过插件自己的移动热区（z-index 2）与 resize 手柄（3），公共实现取 `z-index: 4`；全屏图标用
  `IconFullscreenOutline16`（仅有展开方向，无收缩图标，两种状态共用并切换 aria-label）。
- 全屏能力由 `packages/plugin-ui/src/dialog-fullscreen.ts` 提供：`useDialogFullscreen`（进入前保存几何、
  退出写回、窗口 resize 跟随、按 `open`/`identity` 复位）、`dialogFullscreenButtonRule`、`DialogFullscreenButton`。
  几何写入与拖动 resize 共用同一组 custom properties；全屏时插件隐藏拖动与八向手柄。
- 实例：services 日志弹窗（`packages/plugins/services/src/client/log-dialog.ts`）与
  turn-retry 原因弹窗（`packages/plugins/turn-retry/src/client/reason-dialog.ts`）共用同一实现，
  只有 dialog class、data 属性名和图标不同。

## Dock 约定

出处：`packages/client/ui-conversation/src/client/skeleton/TodoPanel.module.css`、`TodoPanel.tsx`、
`queue/QueueDock.module.css`。项目 dock 外观沿用官方 todo，不独立设计。

| 项目 | 规则 |
|---|---|
| 宽度 | margin:0 auto；width:calc(100% - 侧留白×2 - dock内缩×4)；max-width:calc(var(--dsh-composer-card-max-width) - dock内缩×4) |
| 背景与边框 | var(--dsw-specific-tip)；0.5px solid var(--dsw-alias-border-l1) |
| 圆角 | 12px |
| 表头 | 整行 button、aria-expanded、gap:10px、padding:8px 12px；嵌套 flex 居中 |
| 标题与摘要 | 13px，标题 500/primary，摘要 tertiary；ellipsis 放内层 span |
| 列表行 | 单行不换行；可变长文本给 `min-width:0` + ellipsis，行尾按钮组包在 `flex:none` 容器里不被压缩（实例：services 的 ServiceRow） |
| 图标 | ui-primitives 的 outline 图标；services 与 terminal 共用 IconApiOutline14 |
| 箭头 | 收起状态 IconChevronUpOutline14，展开状态 IconChevronDownOutline14 |
| 滚动条 | --dsh-scrollbar-thumb 与 hover 使用 scrollbar-bg-l2、scrollbar-hover-l2 |

@deepseek-ai/dsh-client-ui-primitives 必须 external，复用页面已有组件与 CSS。
dsh `0.1.5-rc.2` 将通用文件图标统一为 `FileTypeIcon`（用 `path` 或 `kind` 选择类型），不再导出旧的
`DocumentFileIcon`；项目浏览器插件应使用新接口，并在需要时显式传 `size`。该包带 CSS，不能在 environment:node
单元测试中直接 import 含它的浏览器模块。