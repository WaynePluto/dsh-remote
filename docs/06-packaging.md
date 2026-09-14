# 06 · 打包与分发

## 1. 分发目标

发行物是目录形态 zip，使用用户安装的 Node >=22.19.0，不携带 Node 二进制。
launcher、relay、connector 使用纯 JS 与 Node 内置模块；dsh 的依赖包含平台二进制，因此按平台打包。

| 目标 | 命令 | 入口 |
|---|---|---|
| Windows x64 | pnpm release:win | dsh-remote.exe、start.ps1 |
| Linux x64 glibc | pnpm release:linux | start.sh |
| macOS arm64 | pnpm release:mac | start.sh |

`pnpm release` 构建全部目标。完整参数见 [pack.mjs](../scripts/pack.mjs)。
普通构建不需要重新生成图标；Windows exe 构建需要 Go，用户运行不需要 Go。

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
├─ dsh-remote.exe / start.ps1 / start.sh
├─ README.txt
├─ dsh-remote.config.example.json
├─ package.json
├─ dist/index.js
└─ node_modules/
   ├─ @dsh-remote/relay/dist/cli.js
   ├─ @dsh-remote/connector/dist/cli.js
   ├─ @dsh-remote/dsh-plugin-*/
   └─ @deepseek-ai/dsh/
```

relay、connector 保持各自包位置，确保嵌套依赖从正确目录解析。
普通插件必须同时携带 overlay 和 dist，浏览器插件还需要 dist/client.js。
concise-mode 携带 manifest、cordis.patch.yml、locator 产物及两个 preset 目录。

## 3. 启动器

每次启动监督三个子进程：dsh、relay、connector，不自动打开浏览器。

1. 检测 Node 版本、读取配置。
2. 确保专属 profile 存在；缺少 concise Bundle 时非破坏性补入。
3. 首次生成 relay JWT 密钥，收紧文件权限。
4. 校验 Bundle、overlay 和宿主/浏览器产物。
5. 以 pipe 拉起 dsh、前缀转发日志，等待就绪并截获 token。
6. 启动 relay 和 connector，打印访问地址。
7. 监视 membership：`--trusted-host` 集合实际变化时（加入/改换/取消远程入口）自动重启 dsh
   并连带重启 connector 上报新 token；进度原子写入 `~/.dsh-remote/dsh-restart-status.json`，
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
- 输出写入 home 下 dsh-remote.log，超过 2 MiB 轮转一代。
- 自启动状态来自 HKCU Run。
- exe 未签名，SmartScreen 可能提示未知发布者。

### 图标与 DPI

图标源为 packaging/dsh-remote.svg，使用固定品牌蓝和白色底板。
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

可选配置文件 dsh-remote.config.json，通过 `--config <path>` 指定。

```json
{
  "dsh": { "port": 3080 },
  "relay": { "port": 30809, "host": "0.0.0.0", "slug": "my-pc" },
  "home": "~/.dsh-remote"
}
```

| 字段 | 默认 | 用途 |
|---|---|---|
| dsh.profile | dsh-remote-web | 专属 profile |
| dsh.port | 3080 | dsh 端口，绑定 127.0.0.1 |
| dsh.extraArgs | [] | dsh 额外参数 |
| relay.port | 30809 | 控制台端口 |
| relay.host | 0.0.0.0；配了 domain 时 127.0.0.1 | 局域网访问监听地址；域名模式只监听 loopback，公网流量走前置 TLS 反代 |
| relay.slug | 由主机名推导 | 机器名 |
| relay.domain | （不设置） | 公网根域；设置后 relay 以域名模式运行，机器地址是 `https://<slug>.<域名>`，launcher 同时把它加入 dsh 的 trusted host |
| relay.data | home/relay.db | SQLite 数据库 |
| home | ~/.dsh-remote | 设备密钥、membership、JWT 密钥与日志 |

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

release 支持 `--skip-build` 复用 dist、`--skip-exe` 跳过 Windows exe；不带 target 时选择当前平台。
不要使用 `pnpm pack` 代替 release，它是 pnpm 自带的包归档命令。

打包流程：

1. 构建所有工作区产物。
2. 检查目标平台依赖。
3. 一次 pnpm deploy --filter=@dsh-remote/launcher --prod 生成自洽依赖树。
4. 复制平台入口、说明与配置；Windows 额外编译托盘 exe。
5. 校验插件产物，并按目标裁剪平台依赖。
6. 运行入口冒烟检查；当前平台在裁剪后运行，其他平台在裁剪前验证 JS 依赖图。
7. 排除 pnpm registry 账本，输出 release/dsh-remote-<version>-<zipTag>.zip（Windows 为 win-x64）；
   条目直接放在 zip 根目录，没有版本目录层。

各包依赖保持真实嵌套关系，不手动拍平。任一必要工件或冒烟检查失败时不产出该包。

### 发布说明

每个版本发布前在 `docs/changelog/<版本>.md` 写一份用户视角的更新说明
（新能力、安装运行变化、已知限制），并把版本加进根目录 [CHANGELOG.md](../CHANGELOG.md)
的索引。推 tag 后 release 工作流会校验该文件存在并把它作为 GitHub Release 正文，
版本号带 `-`（如 rc）自动标记为预发布。

## 6. 服务器部署

见 [deploy/README.md](../deploy/README.md)、[Caddyfile](../deploy/Caddyfile) 与 [systemd unit](../deploy/dsh-remote.service)。
systemd 以个人普通用户管理 launcher，Restart=always 负责整套恢复；默认运行数据在 `~/.dsh-remote`，
官方 dsh 数据在 `~/.dsh`，工作目录从用户家目录开始。个人模式不使用 `ProtectHome`、`NoNewPrivileges`、
`ProtectSystem` 或 `ReadWritePaths`，sudo 仍由系统策略控制。JWT 密钥由 launcher 生成，不写入 unit。
公网部署在配置里写 `relay.domain`，relay 监听 loopback，TLS 代理原样保留 Host。

后续发布任务与平台实机验收统一记在 [当前进度](05-roadmap.md)。