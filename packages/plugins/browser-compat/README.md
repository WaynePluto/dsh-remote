# browser-compat

垫平 dsh 前端在旧浏览器上缺失的 Web 平台 API，并提供当前页面内存中的轻量浏览器诊断。包含
Host 注入脚本和 client 设置页，不读取或写入任何持久化存储。

## 解决什么问题

dsh 前端官方 bundle 在模块顶层引用 `Iterator` 全局（ES2025 Iterator helpers）：
`@deepseek-ai/dsh-client-ui-sidebar-documentpreview` 内联的 pdf.js 带一段
`typeof Iterator.prototype.join` 探测。Safari 18.4 之前的 WebKit 没有这个全局，模块求值直接抛 “Can't find variable: Iterator”；
部分较新的引擎虽然已有标准 helpers，却没有 pdf.js 探测的 `Iterator.prototype.join`，也需要补上。
否则插件加载失败，整个 dsh Web UI 无法启动——影响所有 iPhone/iPad 上的 Safari 与内嵌 WebView，
与是否走 relay 无关。

## 怎么做

订阅 `webserver/index-inject`，向每次渲染的 index.html 注入一条
`{ kind: 'script', placement: 'head' }` 内联脚本。脚本由两个完全自包含的函数体组成，
head 经典脚本先于页面模块（combo bundle）执行：

- `Iterator` helpers：旧引擎安装常用子集 `map/filter/take/drop/flatMap/reduce/toArray/
  forEach/some/every/find/join`、`Iterator.from`、`[Symbol.iterator]` 和提前退出时的 close 语义；
  已有标准 helpers 的引擎保留原生实现，只补 pdf.js 所需的 `join`。
- `AbortSignal.any`、`AbortSignal.timeout`、`AbortSignal.prototype.throwIfAborted`、
  `Promise.withResolvers`：只在原生 API 缺失时安装，用于覆盖当前 dsh 浏览器端已确认的调用路径。

垫片函数必须完全自包含——序列化后不再有模块作用域——测试在源码、序列化文本和构建产物
三个形态上跑行为断言。现有 dsh 版本中，`AbortSignal.any` 被工作区导航、远程事件流、PDF
预览等多条路径使用；因此这不是只针对目录选择器的特例。

同一条 head 脚本还会建立 `__DSH_REMOTE_BROWSER_COMPAT__` 临时桥：

- 捕获 `window.error`、`unhandledrejection`、资源加载失败、`console.error` 和 `console.warn`。
- 只保存截断后的文本、堆栈、来源、时间和重复次数；最多保留 200 条不同记录。
- 通过 `ctx.slots.onEntryError` 补充记录 dsh/插件槽位渲染错误。
- 页面设置中提供“浏览器日志”页，可查看能力清单、展开堆栈、复制单条/全部日志和清空日志。

诊断桥只存在于当前页面的 JavaScript 内存，不使用 settings、`localStorage`、`sessionStorage`、
RPC、文件或数据库；不上传、不跨设备同步，刷新或关闭页面后自然清空。原始 Console 调用和
浏览器错误事件仍保持原行为。

## 边界

- 只在 dsh-remote-web profile 生效，不改官方 web profile，不触碰 relay 转发。
- 只垫当前 dsh 前端实际踩到的缺口；不做通用浏览器兼容层，不引入第二个 polyfill 体系。
- 诊断不是 DevTools 镜像：被 catch 且没有 Console/错误边界报告的错误、浏览器内部网络/CSS
  警告、Worker 独立上下文和页面崩溃可能不可见。
- 日志只在当前页面内存中存在；设置页关闭不清空，刷新/关闭整个页面才清空。
- 加载体积增加一条小型自包含启动脚本和一个按需加载的设置 client bundle；documentpreview
  的 bundle 照常下载，本插件不复制上游组件。

## 停用与补回

本插件是受管 Profile Bundle（默认全开）。在 dsh 插件页停用后：现代浏览器无感；旧 WebKit（旧 Safari / 手机 WebView）可能白屏，设置里的「浏览器日志」页也随之消失。launcher 不再自动补回；右键托盘图标选「补回浏览器兼容」，或运行 `node dist/index.js --restore-bundle @dsh-remote/dsh-plugin-browser-compat` 补回。想让停用被托盘感知，请用 dsh 插件页的开关（直接改 profile patch 层的停用托盘看不见）。
