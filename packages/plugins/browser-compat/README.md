# browser-compat

垫平 dsh 前端在旧浏览器上缺失的 Web 平台 API。仅 Host 侧，无浏览器模块。

## 解决什么问题

dsh 前端官方 bundle 在模块顶层引用 `Iterator` 全局（ES2025 Iterator helpers）：
`@deepseek-ai/dsh-client-ui-sidebar-documentpreview` 内联的 pdf.js 带一段
`typeof Iterator.prototype.join` 探测。Safari 18.4 之前的 WebKit 没有这个全局，
模块求值直接抛 “Can't find variable: Iterator”，插件加载失败，整个 dsh Web UI
无法启动——影响所有 iPhone/iPad 上的 Safari 与内嵌 WebView，与是否走 relay 无关。

## 怎么做

订阅 `webserver/index-inject`，向每次渲染的 index.html 注入一条
`{ kind: 'script', placement: 'head' }` 内联脚本：`iteratorPolyfill()` 的函数体经
`toString()` 序列化。head 经典脚本先于页面模块（combo bundle）执行，垫平一定发生在
pdf.js 探测之前。浏览器已有原生 `Iterator` 时不做任何事。

polyfill 覆盖常用子集：原型方法 `map/filter/take/drop/flatMap/reduce/toArray/
forEach/some/every/find/join`、`Iterator.from`、`[Symbol.iterator]`，以及规范
“提前退出时通知内层 `return`” 的 close 语义。函数必须完全自包含——序列化后不再有
模块作用域——测试在源码安装、序列化文本、构建产物三个形态上跑同一份行为断言。

## 边界

- 只在 dsh-remote-web profile 生效，不改官方 web profile，不触碰 relay 转发。
- 只垫 dsh 前端实际踩到的缺口；不做通用浏览器兼容层，不引入第二个 polyfill 体系。
- 加载体积不变：documentpreview 的 bundle 照常下载，本插件只是让它在旧 WebKit 上
  能跑起来。
