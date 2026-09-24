# 06 · 打包与分发

## 1. 分发目标

发行介质分两类（D21/D22）：

- **桌面版**（packages/desktop，Wails）：安装包 + 便携 zip，分 lite/full 两档。
  完整版附带固定版本 Node（清单见 `packaging/desktop-node.json`，SHA-256 校验）与
  Office 预览引擎；轻量版要求系统 Node ≥ 22.19.0，不带引擎。
  win 用 NSIS（`packaging/desktop-installer.nsi`），mac 出 `.app` zip（未签名），
  linux 出 deb（纯 Node 构建，含 `.desktop` 与图标）。桌面壳依赖系统 WebView/CGO，
  只能在对应平台上构建（`scripts/pack-desktop.mjs` 强制 target = 本机平台），
  mac/linux 介质由 CI 原生 runner 产出。
- **服务版 zip（本节所述绿色包）**：目录形态 zip，使用用户安装的 Node ≥ 22.19.0，
  不携带 Node 二进制。launcher、relay、connector 使用纯 JS 与 Node 内置模块；
  dsh 的依赖包含平台二进制，因此按平台打包。

| 介质 | 命令 | 产物 |
|---|---|---|
| 服务版 zip（全平台） | pnpm release | release/dsh-station-<version>-<平台>-<变体>.zip |
| 桌面版 Windows | pnpm release:desktop:win | …-win-x64-desktop-<变体>.zip / -setup.exe |
| 桌面版 Linux | pnpm release:desktop:linux | …-linux-x64-desktop-<变体>.deb / .zip |
| 桌面版 macOS | pnpm release:desktop:mac | …-darwin-arm64-desktop-<变体>.zip（.app） |

推 `v*` 标签时 release 工作流在四路 runner（ubuntu 交叉打包 + 三个原生桌面）构建全部介质，
汇总校验和并附到 GitHub Release。

### 发行变体

每个平台打 lite / full 两个 zip（用户文案：轻量版 / 完整版），文件名带变体后缀，
没有无后缀的默认包。两者是同一个程序：lite 只剔除引擎类重组件，目前只有 LibreOffice
引擎（dsh 0.1.6 起 Office 文档转 PDF 预览使用，压缩后每平台约多 58～121 MB）。

- 排除清单是 pack/manifest.mjs 的 `HEAVY_ENGINE_PACKAGES`，按包名匹配
  `@deepseek-ai/libreoffice-kit-*` 平台引擎包；`libreoffice-kit` JS 壳必须保留，
  `dsh-office-to-pdf` 顶层 import 它，删壳 dsh 起不来。
- 缺引擎只影响 Office 预览：dsh 正常启动，首次转换时才报错。
- 打包时验收：full 里必须真的有引擎、lite 里必须一个不剩，否则响亮失败。
- 上游再引入重组件时，按「optionalDependencies 平台包、惰性加载可降级、体积值得」
  三条件决定是否进 lite 排除清单。

### 介质规划（D22）

win/mac 在桌面版完成该平台实机验收后仅保留桌面版安装包；Linux 保留桌面版与服务版 zip。
服务版 zip 始终使用系统 Node；桌面版完整版附带固定版本 Node，轻量版仍要求系统 Node。
完整版的 Office 引擎直接打进安装包，不做按需下载。zip 退役按平台实机验收分别推进，
不设全局时间点。桌面版打包详见 `packages/desktop/README.md`。

### 跨平台依赖

根 manifest 的 pnpm.supportedArchitectures 拉取目标平台预编译包，ignoredOptionalDependencies
排除 win32-arm64、linux-arm64、darwin-x64 与 musl 变体。
supportedArchitectures 是 os × cpu × libc 笛卡尔积，不能直接声明三元组。

- 对应平台被排除的开发机不能直接使用该配置，需要先调整规则。
- 新增发行目标同时修改 TARGETS、架构配置与 lockfile。
- Linux 包要求 glibc，不适用于 Alpine/musl。
- 全目标命令缺某平台依赖时告警跳过，全部缺失才失败；显式目标缺依赖则失败。
- 平台预检同时支持 .pnpm 虚拟 store 与 hoisted 布局。
- node-pty、sharp、koffi、ripgrep 等平台工件会裁剪到目标系统。

跨平台构建只证明 JS 依赖图可用；发布前仍需在目标系统解压运行。

## 2. 产物结构

```text
（zip 根目录，解压即用，无版本目录层）
├─ dsh-station.exe / start.ps1 / start.sh
├─ README.txt
├─ dsh-station.config.example.json
├─ package.json
├─ dist/index.js
├─ plugins/
│  ├─ catalog.json
│  ├─ remote-experience/
│  ├─ model-enhancements/
│  └─ …                         # 10 个第三方 Bundle 安装目录
└─ node_modules/
   ├─ @dsh-station/relay/dist/cli.js
   ├─ @dsh-station/connector/dist/cli.js
   ├─ @dsh-station/dsh-plugin-remote-privileged/
   ├─ pnpm/
   └─ @deepseek-ai/dsh/
```

relay、connector 与壳级 remote-privileged overlay 保持各自包位置，确保 connection 注入、模型 HMR 启动屏障及嵌套依赖从正确目录解析。
功能插件不再放在 launcher 的安装锚中，而由 `plugin-catalog.json` 生成到 `plugins/`；组合包把组件
放在自身 `node_modules/@dsh-station/` 下。浏览器插件必须携带 `dist/client.js`；concise-mode 是
无可执行入口的纯 Bundle，在 patch 内联声明两个预设。随包 pnpm 供 launcher 和 dsh 原生插件管理页离线调用。
安装前，launcher 会把介质及其运行时依赖复制到 profile 的 `.dsh-station-plugin-media/`。原生插件页
仍接受 `.dev/plugins/<目录>` 或发行 `plugins/<目录>`；launcher 放入 PATH 的 pnpm 代理会按包名把跨盘
受管介质映射到这份同盘镜像，避免 pnpm hoisted linker 生成指向 `profile/D:\\...` 的坏 junction。
因此安装日志保留用户选择的介质路径，profile dependency 则有意记录同盘缓存。旧 profile 的 pnpm
主版本不同时会事务式重建 `node_modules`；安装失败时恢复原 manifest、lockfile 和依赖目录。

## 3. 启动器

每次启动监督三个子进程：dsh、relay、connector，不自动打开浏览器。

1. 检测 Node 版本、读取配置。
2. 确保专属 profile 基础结构存在；首次从 `plugins/` 默认安装功能 Bundle，后续配套升级仍安装项并保留停用状态。
3. 首次生成 relay JWT 密钥，收紧文件权限。
4. 校验插件安装介质、壳级 overlay 和宿主/浏览器产物。
5. 以 pipe 拉起 dsh、前缀转发日志，等待就绪并截获 token。
6. 启动 relay 和 connector，打印访问地址。
7. 监视 membership：`--trusted-host` 集合实际变化时（加入/改换/取消远程入口）自动重启 dsh
   并连带重启 connector 上报新 token；进度原子写入 `~/.dsh-station/dsh-restart-status.json`，
   本机控制台「远程入口」页读取并展示。集合未变化的重写（token 清理、自挂条目刷新）不触发重启。
8. SIGINT/SIGTERM 按 connector → relay → dsh 逆序关闭，超时强杀。
9. 任一子进程异常退出，输出诊断并整体退出，由 systemd 等外部管理器决定重启。

Windows 进程树通过 taskkill /T /F 清理；只调用 child.kill() 不足以结束派生 shell。

### Windows 托盘

Go 标准库调用 Win32 API，无 cgo 或 Go 模块依赖。菜单提供打开 dsh 界面（relay 根路径，双击同此）、
打开管理界面（`/_admin`）、启动/停止/重启、查看日志、开机自启动和退出。两个入口都经 relay，
由它完成 dsh 的 token 交换；账号初始化与恢复在管理界面完成。

- 工作目录由 exe 自身路径确定，发行目录可移动。
- 命名互斥量保证单实例；Win32 Job Object 负责托盘退出后的子进程清理。
- 输出写入 home 下 dsh-station.log，超过 2 MiB 轮转一代。
- 自启动状态来自 HKCU Run。
- exe 未签名，SmartScreen 可能提示未知发布者。

### 图标与 DPI

图标源为 packaging/dsh-station.svg，使用固定品牌蓝和白色底板。
`node packaging/make-icons.mjs` 生成 relay 图标模块、ICO 和内嵌资源 syso。
重新生成需要 Chrome/Edge，可用 CHROME_PATH 指定；普通构建与用户运行不需要浏览器参与图标生成。

syso 同时包含图标与 per-monitor DPI manifest，Go 会自动链接；缺失时打包脚本拒绝构建。
托盘使用 SM_CXSMICON 请求真实尺寸。资源声明 asInvoker，避免无意触发提权。
relay 图标内联为模块，在 /_icon/ 提供固定字节，不占用 dsh favicon。

### 其他入口与首次设置

start.ps1 需要 PowerShell 7；start.sh 使用 POSIX sh，并在归档中保留 0755 权限。
首次运行后，在启动日志给出的 loopback 控制台设置管理员密码、绑定 TOTP 并确认动态码。
向导只对“无管理员 + loopback socket + loopback Host”开放。
无桌面服务器使用 [部署说明](../deploy/README.md) 中的 CLI 初始化流程。

relay 每次启动都会把本机挂到它自己身上（membership.json 中带 `selfManaged` 标记的自挂
条目，附一次性注册令牌），connector 随即拨 loopback 注册。没有这一步，控制台根路径与
局域网地址会因为「机器离线」打不开 dsh；机器控制台的「机器」页也会列出这台本机。

## 4. 配置

可选配置文件 dsh-station.config.json，通过 `--config <path>` 指定。

```json
{
  "dsh": { "port": 3080 },
  "relay": { "port": 30809, "host": "0.0.0.0", "slug": "my-pc" },
  "home": "~/.dsh-station"
}
```

| 字段 | 默认 | 用途 |
|---|---|---|
| dsh.profile | dsh-station-web | 专属 profile |
| dsh.port | 3080 | dsh 端口，绑定 127.0.0.1 |
| dsh.extraArgs | [] | dsh 额外参数 |
| relay.port | 30809 | 控制台端口 |
| relay.host | 0.0.0.0；配了 domain 时 127.0.0.1 | 局域网访问监听地址；域名模式只监听 loopback，公网流量走前置 TLS 反代 |
| relay.slug | 由主机名推导 | 机器名 |
| relay.domain | （不设置） | 公网根域；设置后 relay 以域名模式运行，机器地址是 `https://<slug>.<域名>`，launcher 同时把它加入 dsh 的 trusted host |
| relay.data | home/relay.db | SQLite 数据库 |
| home | ~/.dsh-station | 设备密钥、membership、JWT 密钥与日志 |

远程入口在控制台设置，运行时写入 membership.json，不以 relay.url 等配置表达。
dsh 本身沿用标准 DSH_HOME；两种 home 职责不同。

launcher 自动为 dsh 推导 127.0.0.1、localhost、局域网 IPv4 与远程入口 browserAuthority 的 trusted host。
值必须是裸 host 或 host:port；入口地址变化后需重启。
profile 装载与共享范围见 [决策](01-decisions.md)。

## 5. 构建与检查

```powershell
pnpm check:dependencies
pnpm build
pnpm release:win
```

release 支持 `--skip-build` 复用 dist、`--skip-exe` 跳过 Windows exe、`--variant=<lite|full>`
只打指定变体（默认全打）；不带 target 时选择当前平台。
不要使用 `pnpm pack` 代替 release，它是 pnpm 自带的包归档命令。

打包流程：

1. 构建所有工作区产物。
2. 检查目标平台依赖。
3. 一次 pnpm deploy --filter=@dsh-station/launcher --prod 生成自洽依赖树。
4. 从 `plugin-catalog.json` 生成根目录 `plugins/` 安装介质，再复制平台入口、说明与配置；Windows 额外编译托盘 exe。
5. 校验插件介质、壳级 overlay 和运行产物，并按目标裁剪平台依赖。
6. 运行入口冒烟检查；当前平台在裁剪后运行，其他平台在裁剪前验证 JS 依赖图。
7. 排除 pnpm registry 账本，按变体各写一个 zip：full 直接打包，lite 先剔除
   引擎类重组件再打包（release/dsh-station-<version>-<zipTag>-<lite|full>.zip）；
   条目直接放在 zip 根目录，没有版本目录层。

各包依赖保持真实嵌套关系，不手动拍平。任一必要工件或冒烟检查失败时不产出该包。

### 发布说明

每个版本发布前在 `docs/changelog/<版本>.md` 写一份用户视角的更新说明
（新能力、安装运行变化、已知限制），并把版本加进根目录 [CHANGELOG.md](../CHANGELOG.md)
的索引。推 tag 后 release 工作流会校验该文件存在并把它作为 GitHub Release 正文，
版本号带 `-`（如 rc）自动标记为预发布。

## 6. 服务器部署

见 [deploy/README.md](../deploy/README.md)、[Caddyfile](../deploy/Caddyfile) 与 [systemd unit](../deploy/dsh-station.service)。
systemd 以个人普通用户管理 launcher，Restart=always 负责整套恢复；默认运行数据在 `~/.dsh-station`，
官方 dsh 数据在 `~/.dsh`，工作目录从用户家目录开始。个人模式不使用 `ProtectHome`、`NoNewPrivileges`、
`ProtectSystem` 或 `ReadWritePaths`，sudo 仍由系统策略控制。JWT 密钥由 launcher 生成，不写入 unit。
公网部署在配置里写 `relay.domain`，relay 监听 loopback，TLS 代理原样保留 Host。

后续发布任务与平台实机验收统一记在 [当前进度](05-roadmap.md)。