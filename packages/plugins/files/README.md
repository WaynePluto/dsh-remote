# @dsh-remote/dsh-plugin-files

给 dsh 原生右侧 Sidebar 文件能力增加 Git 状态和文件树右键菜单。
本插件不再提供第二套目录树或文件预览；原生 `ui-sidebar-files` 负责树，原生
`ui-sidebar-documentpreview` 负责文件资源预览。

## 使用

打开右侧 Sidebar，在原生「开始」页选择「工作区文件」，进入原生「文件」页；「新建终端」和「浏览器」入口仍由 dsh 提供，不受本插件影响。宽屏下：

- 文件树保持在左侧 pane；首次点文件时，插件通过原生 Sidebar `split` 建立右侧 pane；
- 文件在原生文档预览 tab 中打开，支持 dsh 已有的 Markdown、代码、纯文本、图片、PDF 和 HTML 预览；
- 单击文件使用 VS Code 式临时预览：标题为斜体，后续单击会复用同一页签；双击文件或页签标题后转为保留页签；
- 图片预览提供缩小、放大、100%、适应窗口和 Ctrl/⌘+滚轮缩放，原生滚动用于查看放大内容；按住 Space 后在图片滚动区域按鼠标左键拖动可平移溢出的图片（输入框、选中文字、其他页签和触摸操作不受影响）；
- 页签标题右键菜单的「关闭其他」「关闭全部」只作用于右键目标所在分栏，不影响另一个分栏；
- 空间不足、用户已有布局无法协调或目标 pane 已被移动时，退回原生文件树自己的打开行为，不阻断浏览。

最终用户只看到一个「文件」入口，不再有「文件 pro」。插件不注册额外入口，也不覆盖「开始」页。
原生文件树的登记项由插件以 slot shadow 方式包装，原始 component、store、inject 和 locale
均保留；插件不复制上游树源码。

## Git 状态

Git 状态在树加载和点击原生刷新时读取。宿主执行无 shell 的：

```text
git -c core.fsmonitor=false --no-optional-locks -C <session cwd> status --porcelain=v2 -z --untracked-files=all -- .
```

另以无 shell 的 `git rev-parse --show-prefix` 将仓库根路径投影回 Session cwd。状态包括：

- `M` 修改、`A` 新增、`D` 删除、`R` 重命名、`C` 复制、`?` 未跟踪、`U` 冲突；
- 文件按自身状态显示，目录聚合后代中优先级最高的状态；
- 字符、颜色、`aria-label` 和 `title` 同时表达状态；
- 不向树中插入已删除文件的虚拟行；
- 缺少 Git、非仓库、失败、超时或输出截断只显示降级状态，不阻断原生文件浏览。

status 命令总预算为 3 秒、stdout 1 MiB、最多投影 2000 项。Git 状态不是完整实时信号；
原生 dsh 的 `fs/observed` 不覆盖所有 shell、Git 或外部编辑器操作。

## 目录右键菜单

目录和文件行均保留两个只读操作：

- **复制路径**：复制目标机器上的绝对路径；Windows 使用目标平台分隔符；
- **复制相对路径**：复制相对于当前 Session 工作区根的 slash 路径。

菜单使用 dsh external `Menu` 和 `writeClipboard`，通过局部事件委托挂在原生树外层，支持鼠标右键、
ContextMenu/Shift+F10、portal 定位、Escape 关闭和焦点归还。右键不会触发展开、预览或任何写入操作。
复制失败会保留菜单并显示错误。菜单不劫持树外或右侧预览区域的浏览器右键。

## 读取边界

文件正文和目录列表完全由 dsh 原生 `workspaceFiles` 提供，不再经过本插件的 `/files/list` 或 `/files/read`。
因此跟随 dsh 原生边界：目录列举限制在 Session 工作区；文件读取使用 dsh 组合文件系统授权，可能读取
工作区外路径；文本分页、完整字节上限、变更观察和 HTML 隔离 iframe 均以 dsh 版本为准。
这不再声称旧 files 实现的逐段 symlink 拒绝和读取前后身份复核。

本插件的私有通道只保留：

```text
/files/snapshot { sessionId } → { workspacePath, git }
```

它不提供写入、新建、重命名、删除、Git 修改或模型工具。

## 开发检查

```powershell
pnpm --filter @dsh-remote/dsh-plugin-files test
pnpm --filter @dsh-remote/dsh-plugin-files typecheck
pnpm --filter @dsh-remote/dsh-plugin-files build
node scripts/files-check.mjs
```

源码依赖当前 dsh `0.1.7-rc.1` 的 Sidebar/slot 契约及原生图片滚动容器 `data-document-zoom-scrollport`。插件通过 `dsh.client.inject`
声明对 `@deepseek-ai/dsh-client-ui-sidebar-files` 的模块图依赖，但不深层 import 上游源码。
如果上游登记项、行 data 属性或 Sidebar 导航契约变化，检查必须响亮失败并重新适配。

`dsh-remote-web` 没有 HMR。修改宿主、浏览器代码或样式后，必须重新构建并重启 dsh；只刷新页面不会
重新加载冻结的浏览器产物。

## 分发与管理

本插件作为独立 Bundle 分发，可单独停用、卸载和升级。停用后，Git 状态、目录右键菜单与预览增强消失，回到 dsh 原生文件树；本插件不提供写入接口的性质不变。
launcher 首次默认安装本插件；后续只升级仍已安装的插件并保留停用状态，卸载后不会自动补回。
需要重装时，在 dsh「添加插件」中填写发行包 `plugins/files` 或开发环境 `.dev/plugins/files` 的绝对目录，而不是源码目录或 `dist/index.js`。

原生插件列表中的标题是 **plugin-files**，详情页显示完整包名 `@dsh-remote/dsh-plugin-files` 与 Bundle 行 `files`。副标题来自 package.json 的中文 `description`；标题仍由 dsh 根据 npm 包名生成。
