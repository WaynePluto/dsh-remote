# 06 · 打包与分发

> 本文档描述**当前实际实现**，与代码一致。历史上被否决的方案见 §8。

## 1. 分发策略

**绿色包（目录形态的 zip），使用用户本机 Node，不携带 Node 二进制。**（D5，用户二次确认）

```
下载对应平台的 zip → 解压 → 双击 / 跑启动脚本 → 浏览器里完成设置
```

### 1.1 为什么按平台分包

我们**自己的代码零原生模块**（口令哈希用 Node 内置 `crypto.scrypt`，见 §5），
但 **dsh 自己的依赖带按平台安装的预编译二进制**，实测扫描确认：

| 包 | 情况 |
|---|---|
| `node-pty` | 自带全平台 prebuilds（`prebuilds/<platform>-<arch>/`）|
| `@img/sharp-*` | 仅当前平台 |
| `@koromix/koffi-*` | 仅当前平台 |
| `node-addon-require-builtin-*` | 仅当前平台 |
| `@vscode/ripgrep-*` | 仅当前平台 |

所以产物文件名**必须带平台后缀**：`dsh-remote-0.0.1-win32-x64.zip`。
包里有 `start.sh` 不代表它能在 Linux 上跑 —— 决定平台的是 `node_modules` 里的二进制。

**三个发行目标**（`scripts/pack.mjs` 里的 `TARGETS`）：

| 目标 | 命令 | 包根独有的文件 |
|---|---|---|
| `win32-x64` | `pnpm release:win` | `dsh-remote.exe`（图标与高 DPI 清单已内嵌）、`start.ps1` |
| `linux-x64` | `pnpm release:linux` | `start.sh` |
| `darwin-arm64` | `pnpm release:mac` | `start.sh` |

`pnpm release` = 三个目标都跑一遍。

### 跨平台打包（已解锁）

根 `package.json` 配了 `pnpm.supportedArchitectures`，一次 `pnpm install` 就把声明的各平台
预编译二进制都拉进开发机的 `node_modules`：

```json
"pnpm": {
  "supportedArchitectures": {
    "os": ["win32", "linux", "darwin"],
    "cpu": ["x64", "arm64"],
    "libc": ["glibc"]
  }
}
```

所以**一台 Windows 机器现在能直接把三个目标全打出来**（已验证，`pnpm release` 一次跑完）。

> 这段配置为什么长这样，只记在这里：JSON 写不了注释，而 `package.json` 的 schema 也不允许
> 在 `pnpm` 里放额外的说明字段（编辑器会报「不允许属性」）。改它之前先读完本节。

- 代价：开发机 `node_modules` 实测 **808 MB**（只要 win32+linux 的 x64 时是 458 MB）。
  单个 zip 不受影响，仍是 **61.5–65.8 MB**：`pruneToTarget` 按包的 `os`/`cpu`/`libc` 字段 +
  `node-pty/prebuilds/<平台>` 裁到单一目标（每个目标裁掉 33–34 项）
- `cpu` 里的 `arm64` 会顺带拉下 `linux-arm64` / `win32-arm64` 那几份（os 与 cpu 是组合展开），
  现在没有对应的发行目标，白占体积但无害；哪天要发 `linux-arm64`（树莓派 / ARM 云主机）
  只需在 `TARGETS` 里加一项
- `libc` 只写 `glibc`：**产出的 linux 包在 Alpine / musl 上跑不了**，`pruneToTarget` 也是按 glibc 取舍的
- lockfile 不受影响：可选依赖本来就全写在 `pnpm-lock.yaml` 里，这个字段只决定装哪几份
- 非本机目标拿不到「裁剪后真跑一次」的证据（见 §5 自检），macOS / Linux 包发前最好在真机上
  解压跑一次 `./start.sh`

目标平台的二进制不在树里时（没配进 `supportedArchitectures`，或配了还没 install）：

- `pnpm release`（全部目标）把打不了的目标**告警并跳过**，一个包都没打出来才算失败
- `pnpm release:linux` 这种**显式点名**的目标打不了则**硬失败**（静静地不产出更坏）
- 判据是哨兵包 `@img/sharp-<platform>-<arch>` 在不在（`storeHasTarget`，先查的是一次预检，
  避免为注定失败的目标白跑一次 deploy）。它同时认两种布局：默认的 `node_modules/.pnpm`
  虚拟 store，和 `node-linker=hoisted` 下扁平的 `node_modules/<包名>`。
  只认前者的话，一台全局配了 hoisted 的开发机会被误判成「没装过这个平台」

## 2. 绿色包结构

```
dsh-remote-0.0.1/
├─ dsh-remote.exe               # 仅 win32-x64：双击入口（托盘应用，见 §3.1），图标内嵌在它里面
├─ start.ps1                  # 仅 win32-x64：终端入口（PowerShell 7）
├─ start.sh                   # 仅 linux-x64 / darwin-arm64（POSIX sh，归档内 0755）
├─ README.txt                 # 解压后先看这个（三个平台共用）
├─ dsh-remote.config.example.json
├─ package.json               # 只为声明 "type": "module"
├─ dist/
│  ├─ index.js                # launcher 本体
│  └─ proxy-bootstrap.js
└─ node_modules/
   ├─ @dsh-remote/relay/dist/cli.js       # launcher 真正 spawn 的 relay
   ├─ @dsh-remote/connector/dist/cli.js
   ├─ @dsh-remote/dsh-plugin-remote-privileged/
   │  ├─ dsh-overlay.yml                # launcher 用 --patch 传给 dsh
   │  └─ dist/index.js                  # overlay 用相对路径引用它，两者必须待在一起
   └─ @deepseek-ai/dsh/...              # 内嵌的 dsh（D13）
```

⚠️ **relay 和 connector 不拍平到 `dist/`**。pnpm 可能把版本冲突的传递依赖嵌进它们
各自的 `node_modules/`，bundle 只有从自己所在目录出发才解析得对。
`resolveRelayEntry` / `resolveConnectorEntry` 因此优先找
`<包根>/node_modules/@dsh-remote/<name>/dist/cli.js`。

## 3. 启动器行为

**一台机器 = 三个子进程**：dsh + relay + connector（D16：每台机器既能当入口机器又能被打开，
本机控制台是给本机设置远程入口的唯一地方）。

**不自动打开浏览器**（D6），只打印地址。

```
  dsh-remote 0.0.1

  ✓ Node v22.19.0
  ✓ dsh 已就绪         127.0.0.1:3080
  ✓ 本机控制台已启动   0.0.0.0:30809

  ┌────────────────────────────────────────────────────┐
  │  本机控制台   http://127.0.0.1:30809     免登录    │
  │  局域网访问   http://10.1.2.87:30809   需登录    │
  └────────────────────────────────────────────────────┘
```

### 3.1 Windows 入口：托盘应用

`dsh-remote.exe` 是 Go 写的 shim（约 1.9 MB，交叉编译，**无 Go 模块依赖**），
`-H windowsgui` 构建，双击后常驻通知区域，不留小黑框。

**全部使用 Win32 原生 UI，不自绘**：`Shell_NotifyIcon` + `CreatePopupMenu` /
`TrackPopupMenu` + `MessageBox` + 气泡通知，经标准库 `syscall.NewLazyDLL` 调用
user32 / shell32 / kernel32 / advapi32。

菜单：

```
打开控制台          ← 默认项（加粗），双击图标同效
打开 dsh 界面
──────────
启动 / 停止 / 重启   ← 按状态灰显
──────────
查看日志
开机自启动          ← 勾选状态直接读 HKCU\...\Run
──────────
退出
```

**菜单里刻意没有「初始化 / 重置密码 / 重置 TOTP」**：Win32 没有内置文本输入框，
自己拼对话框就滑向自绘 UI；而这三件事已经全在浏览器控制台里，
一项「打开控制台」即可覆盖，且带二维码，体验更好。

关键实现点：

- **工作目录按 exe 自身路径解析**（`os.Executable` + `EvalSymlinks`），
  解压到任意目录都能用。已实测：从 `C:\` 作为当前目录启动仍正确。
- **子进程树用 Win32 Job Object 兜底**（`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`），
  由内核保证子进程活不过托盘进程。已实测：只强杀托盘进程（不带 `/T`），
  四个 node 子进程全部被连带清理，端口释放。这比 `taskkill /T` 可靠。
- **单实例保护**用命名互斥量，第二次启动立即退出，避免两套栈抢同一批端口。
- 无控制台可打印，故子进程输出重定向到 `<home>\dsh-remote.log`，
  超过 2 MiB 轮转一代（`dsh-remote.log.1`），上限约 4 MiB。
- 找不到 Node 时用 `MessageBox` 中文提示并指向 nodejs.org。

⚠️ **exe 未代码签名**，SmartScreen 首次会提示「无法识别的发布者」，
需点「更多信息 → 仍要运行」。消除它需要购买代码签名证书。README.txt 里已写明。

❌ **`.lnk` 快捷方式方案已实测排除**：它把工作目录写死成绝对路径，
用户解压到别处即失效。

#### 3.1.1 图标与高 DPI

源图是 `packaging/dsh-remote.svg`，全项目（exe、托盘、relay 网页）**只有这一个图标源**：
dsh 官方 favicon 的鲸鱼路径**原样**保留，左上角加一个空心气泡（象征鲸鱼在说话），
底下一块**白色圆角底板**（`rx=11`，即边长的 22%）。

两个约束写在这里，改图时别踩：

- **鲸鱼不做遮罩挖空**，气泡与鲸鱼之间靠留白分开（约 5 个画布单位，50×50 视图），
  挖空会咬掉鲸鱼的背；间距小于这个值时 16px 下两者会糊成一坨
- **底板是白的，所以前景固定品牌蓝 `#4D6BFE`**，不再跟随 `prefers-color-scheme`：
  深色主题下把前景翻成白的，在白底板上就看不见了

一条命令生成三个源码资产（生成后提交，构建期不重新生成）：

```powershell
node packaging/make-icons.mjs
```

| 产物 | 用途 |
|---|---|
| `packaging/win-launcher/rsrc_windows_amd64.syso` | 链进 exe 的资源：**图标** + **应用程序清单** |
| `packages/relay/src/icons.ts` | relay 页面的 favicon（SVG + ICO 16/32/48 + PNG 256，生成代码）|
| `packaging/dsh-remote.ico` | 图标文件，**不进发行包**，留给外部使用与预览 |

该脚本用 Chrome / Edge 的 headless 截图把 SVG 渲成 16/20/24/32/48/64/128/256 八个
尺寸，再自己组装 ICO（<256 存 32bpp BMP，256 存 PNG）和 COFF 资源对象
（`.rsrc` 节 + 每个 data entry 一条 `IMAGE_REL_AMD64_ADDR32NB` 重定位）。
**只在重新生成资源时需要浏览器**，普通构建和运行都不需要；
找不到浏览器时可用 `CHROME_PATH` 指定。

relay 侧的图标字节**内联成 TS 模块**而不是运行时读文件：绿色包里的 relay 就地跑在
`node_modules` 里（§2），多一个需要解析路径的资源文件只会多一个坏点。
路由在 `/_icon/` 下（`dsh-remote.svg` / `.ico` / `.png`），**不占用 `/favicon.ico`**，
因为那是隧道对面 dsh 前端自己的路径；与 webmanifest 同理，图标在**认证之前**就服务
（浏览器不带凭据取图标，而登录页自己也要有图标），字节是构建期固定内容，
不泄露任何机器状态。页面 CSP 因此多了 `img-src 'self'`（Firefox 会拿页面 CSP 卡 favicon）。

`go build` 会自动链包目录下的 `*.syso`，不需要任何 Go 模块依赖（不用 rsrc / goversioninfo）。
⚠️ `.syso` 不在时 `go build` **不报错**，只会编出一个默认图标、高分屏上发糊的 exe，
所以 `scripts/pack.mjs` 在编译前会先检查它在不在。

**托盘图标也读内嵌资源**（`tray.go` 的 `loadTrayIcon`），包里不再带 `.ico` 文件 ——
少一个“别删这个文件”的脆弱点。取图时要的是 `SM_CXSMICON`（而不是 `LR_DEFAULTSIZE`
的 32×32），资源里有 16/20/24/32，LoadImage 能挑到真实尺寸而不是缩一张。

#### 高 DPI

清单里的 `dpiAware=true/pm`（Win8.1）+ `dpiAwareness=permonitorv2,permonitor`
（Win10 1703+）是**托盘右键菜单和 MessageBox 在高分屏上不发糊的原因**：
不声明的进程是 DPI unaware，Windows 会把整个 UI 位图拉伸。
实测对比（125% 缩放的机器，同一段代码带 / 不带 `.syso`）：

```
带 .syso  → DPI awareness = PER_MONITOR_AWARE，GetDpiForSystem = 120
不带     → DPI awareness = UNAWARE，        GetDpiForSystem = 96（被虚拟化）
```

清单另外声明了 `asInvoker`（避免安装器启发式检测误弹 UAC）和 `supportedOS`。
❌ **故意不声明 comctl32 v6 依赖**：这个程序一个公共控件都不用，
而 SxS 依赖解析失败是会直接启动不了的。

.ico / 资源里的颜色固定为品牌蓝 `#4D6BFE`（浅色和深色任务栏上都可见）——
Win32 托盘图标不跟随系统主题，换主题要重新加载图标，不值得。
SVG 本身仍带 `prefers-color-scheme`，网页里用是黑 / 白。

❌ 不用 Go 重画：鲸鱼是一条复杂路径，自己写光栅化器不划算；
也不引 Node 原生图像依赖（铁律 3）。

### 3.2 其他入口

- `start.ps1`：**PowerShell 7**（不用 cmd，用户明确要求）。给想实时看输出的人用。
  ⚠️ `.ps1` 默认不能双击运行（会用编辑器打开，且下载的文件受执行策略拦截），
  README.txt 里写了右键运行 / `pwsh -File` / `Unblock-File` 三种做法。
  **这也是做 exe 的另一个理由**：PowerShell 7 在 Windows 上不是预装的，
  只用 exe 时用户只需要装 Node。
- `start.sh`：POSIX sh，Linux/macOS。

### 3.3 启动器职责

1. 检测 Node 版本，`<22.19.0` 报错并给 nodejs.org 链接
2. 读配置；若 `$DSH_HOME/profiles/dsh-remote-web` 不存在，**仅**写入最小 profile 模板（D14）
3. 首次运行生成 JWT 密钥存 `<home>/relay-jwt.secret`（0600，Windows 收紧 ACL）
4. 定位每个 dsh 插件的 `dsh-overlay.yml` 与它的 `dist/index.js`（D17），缺一个就报错退出
5. `spawn` dsh（`stdio: 'pipe'`，前缀化转发日志，插件以 `--patch` 传入），轮询直到就绪（超时 60s）
6. `spawn` relay 与 connector
7. 打印地址框
8. `SIGINT`/`SIGTERM` 时**按 connector → relay → dsh 逆序**关闭，超时后强杀
9. 任一子进程异常退出 → 打印其最后 50 行输出后整体退出（**不静默重启**）

⚠️ Windows 上杀子进程树要用 `taskkill /pid <pid> /T /F`，`child.kill()` 杀不掉
dsh 派生的 shell。托盘应用另有 Job Object 作为第二道保险。

### 3.4 首次运行：在浏览器里完成

**启动器不再在终端里问密码。** 它照常启动，然后提示：

```
  ○ 还没有管理员账号   需要先在本机浏览器里完成设置
      http://127.0.0.1:30809
```

用户在**本机**打开该地址 → 设密码 → 扫二维码 → 输一次动态码 → 完成。

安全边界（已实测）：向导只在**无管理员**且 **loopback socket + loopback Host
双条件同时成立**（D15）时可达。局域网访问只得到 503 和一句说明，
**页面里没有任何表单**，抢注不了管理员。

> 无图形界面的服务器上向导够不着，改用救急命令 `node dist/relay.js init`，见 §7。

## 4. 配置文件

`dsh-remote.config.json`（可选，缺省即全默认；用 `--config <path>` 指定别的路径）：

```json
{
  "dsh": { "port": 3080 },
  "relay": { "port": 30809, "host": "0.0.0.0", "slug": "my-pc" },
  "home": "~/.dsh-remote"
}
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `dsh.profile` | `dsh-remote-web` | dsh profile 名 |
| `dsh.port` | `3080` | dsh 监听端口（永远 `127.0.0.1`） |
| `dsh.extraArgs` | `[]` | 透传给 dsh |
| `relay.port` | `30809` | 本机控制台端口 |
| `relay.host` | `0.0.0.0` | 便于手机从局域网访问 |
| `relay.slug` | 由主机名推导 | 本机在自己控制台上的名字 |
| `relay.data` | `<home>/relay.db` | SQLite 路径 |
| `home` | `~/.dsh-remote` | 存 `device.key`、`membership.json`、`relay-jwt.secret`、日志 |

⚠️ **远程入口不在这里**。本机挂在哪台入口机器上由 `membership.json` 在运行时管理，
通过控制台的「远程入口」页设置 / 取消（D16）。配置文件里没有 `relay.url` / `slug` / `publicDomain`。

### DSH_HOME / profile 策略（D14）

- 沿用 dsh 标准 home：`$DSH_HOME` 或 `~/.dsh`，不建私有 home
- dsh-remote 用 `dsh-remote-web` profile，官方 `dsh web` 用 `web` profile，互不干涉
- settings、credentials、sessions、home 级 `cordis.patch.yml` 共享
- launcher **不**包装 `plugin add/remove/list`，用户插件沿用官方 `dsh plugin --profile`
- **只在 profile 完全不存在时创建最小模板**；一旦存在就属于用户，不重写、不"修复"

### `--trusted-host` 自动推导

模式 A 原样转发浏览器的 Host，所以 dsh 必须信任浏览器会用的每个地址。
launcher 自动拼出：`127.0.0.1`、`localhost`、本机局域网 IPv4，
以及**从 `membership.json` 读到的入口机器 `browserAuthority`**。

⚠️ 必须是裸的 `host` 或 `host:port`。写错会让 **dsh 插件加载直接失败**（不是运行时 403），
所以 launcher 在 spawn 前逐条校验，规则照 dsh 自己的 `assertTrustedAuthority` 复刻。
入口机器地址变化后需重启本程序，dsh 才会信任新地址。

## 5. 依赖约束

**我们自己的三个包（launcher / connector / relay）零原生模块。**

- 持久化用 **`node:sqlite`**（Node 22.19 内置），不要 `better-sqlite3`
- 口令哈希用 **`node:crypto` 的 scrypt**，不要 `@node-rs/argon2`
  （D16 让 relay 进入桌面绿色包，原生二进制会破坏"解压即用"并把包变成分平台产物；
  scrypt 内存硬、Node 内置，仍是 OWASP 认可的口令 KDF）
- 不引入 `@node-rs/*`、`node-gyp` 系依赖
- Windows 托盘 exe 用 Go 标准库 `syscall`，**不用 cgo、不引 Go 模块依赖**

⚠️ dsh 自己有原生依赖，那是它通过 npm 安装时自己处理的——但它决定了发行包必须分平台（§1.1）。

## 6. 构建

```jsonc
{
  "release": "node scripts/pack.mjs --target=all",
  "release:win": "node scripts/pack.mjs --target=win32-x64",
  "release:linux": "node scripts/pack.mjs --target=linux-x64",
  "release:mac": "node scripts/pack.mjs --target=darwin-arm64"
}
```

⚠️ **不要叫 `pack`**：`pnpm pack` 是 pnpm 内置命令，会打出仓库 tarball 而不是绿色包。

其它参数：`--skip-build`（复用现有 `dist/`）、`--skip-exe`（本机没 Go，
打一个没有 `dsh-remote.exe` 的 Windows 包）。不带 `--target` 就打本机平台。

`scripts/pack.mjs` 流程（每个目标跑一遍 2–7，目标之间串行，共用同一个暂存目录）：

1. `pnpm build`
2. 目标可用性预检：仓库 `.pnpm` store 里有没有这个平台的哨兵包（§1.1）
3. **一次** `pnpm deploy --filter=@dsh-remote/launcher --prod <tmp>` 产出单一自洽依赖树
4. 复制该平台的启动脚本、README、示例配置；win32 目标额外交叉编译 `dsh-remote.exe`
   （`GOOS=windows GOARCH=amd64`，缺 Go 时**硬失败**，除非显式 `--skip-exe`）与拷入图标
5. **裁剪 `node_modules` 到目标平台**（`os`/`cpu`/`libc` + `node-pty/prebuilds/<平台>`），
   再验一遍：本平台哨兵包在、其它平台哨兵包不在、预编译目录只剩自己那一个
6. **写 zip 之前先跑冒烟测试**：真跑各入口，任一模块解析不到就报错且不产出包；
   本机平台的包在**裁剪后**跑（顺便验裁剪），非本机平台的包在**裁剪前**跑
   （JS 依赖图与平台无关，这是它能拿到的唯一一次真实执行证据）
7. 输出 `release/dsh-remote-<version>-<platform>-<arch>.zip`

⚠️ **早期"跑两次 deploy 再平铺合并"的做法已废弃**。它假设"同一 lockfile 版本天然一致"，
而 hoisted 布局下不同消费者可以合法解析到不同版本，实测在
`real-require` 0.2.0 / 1.0.0 上直接撞死。现在由 pnpm 自己决定嵌套：

```
node_modules/real-require                    → 0.2.0（pino 用）
node_modules/thread-stream/node_modules/…    → 1.0.0（thread-stream 用）
```

## 7. 服务器部署

见 [`deploy/`](../deploy/)：`dsh-remote.service`（systemd）、`Caddyfile`、`README.md`。

要点：

- systemd 管的是 **launcher**，不是三个子进程各一个 unit
- `Restart=always`：子进程异常退出时 launcher 会**故意整体停掉**，靠 systemd 拉回来
- `ReadWritePaths` 必须覆盖 dsh-remote home（`relay.db` 是 WAL 模式，
  `-wal`/`-shm` 是同级文件，目录必须可写）、`DSH_HOME` 和 agent 工作目录
- **不要**在 unit 里写 `DSH_REMOTE_JWT_SECRET`，launcher 首次运行会自己生成
- 无图形界面的机器上向导够不着，用 `node dist/relay.js init` 创建管理员
- Caddy 必须**保留原始 Host**（relay 靠它路由，模式 A 再原样转给 dsh），
  泛域名证书需要 DNS-01 挑战，即需要带对应 DNS 插件的 Caddy 构建

## 8. 已否决的方案

| 方案 | 否决理由 |
|---|---|
| ❌ Node SEA / 单文件 exe | dsh 的 profile 机制依赖**磁盘上真实的 `node_modules`**（插件按包名动态解析、`dsh plugin` 转发 pnpm），静态打包会破坏它 |
| ❌ 用 Go 重写 | dsh 本身是 Node 应用且不 fork（铁律 1），Node 运行时躲不掉。用 Go 只会变成"既要 Go 工具链又要 Node"。Go 仅用于那个托盘 shim |
| ❌ 携带 Node 运行时 | 用户明确要求用本机 Node（D5，二次确认）。会让包从 ~64 MB 涨到 ~150 MB |
| ❌ `.lnk` 快捷方式 | 实测：工作目录被写死成绝对路径，解压到别处即失效 |
| ❌ `.cmd` / 批处理 | 用户明确要求用 PowerShell 7 |
| ❌ Electron | 见 01-decisions.md §3 |
| ❌ Docker（当前阶段） | 用户明确要求先不考虑 |

## 9. 后续（不在当前范围）

- PWA 安装引导（M4）
- 代码签名证书，消除 SmartScreen 警告
- 自动更新：下载新 zip 覆盖 `dist/` + `node_modules/`，保留配置与 home
- Linux/macOS 的等价"托盘"体验（目前只有 `start.sh`）
