# 01 · 需求与决策

## 1. 产品目标

通过手机或异地电脑的浏览器操作目标机器上的 DeepSeek Harness（dsh），查看进度、发送指令和回应提问。
文件读写与命令执行发生在目标机器上；入口机器负责认证和转发。
单机使用不要求部署公网服务器。默认固定 YOLO 自动执行，用户提问仍需人工回答。

## 2. 已确认的决策

| 编号 | 决策 | 依据 |
|---|---|---|
| D1 | 使用官方 dsh 运行时 | 用户指定，复用其 Agent、工具和会话能力 |
| D2 | 不 fork、不改 dsh 源码 | 扩展通过插件完成，升级时核对依赖的上游契约 |
| D3 | 反向隧道只搬运 HTTP/WebSocket 字节 | relay 不解析 dsh 业务协议；首页 token 重定向是唯一例外 |
| D4 | 复用 dsh Web UI | 会话、模型、设置等界面由 dsh 与插件提供 |
| D5 | 使用用户安装的 Node，不携带 Node 二进制 | Node 最低版本为 22.19.0 |
| D6 | 提供双击启动器，不自动打开浏览器 | Windows 托盘菜单和终端输出提供访问入口 |
| D7 | 每台机器独立 origin，域名部署使用子域名 | dsh 使用绝对 `/api`，不支持挂子路径 |
| D8 | 浏览器流量经过 relay | 所有非 loopback 访问统一认证 |
| D9 | 隧道使用 Node 与 ws，不要求额外网络客户端 | 保持部署组件精简 |
| D10 | 移动端增强以实机验收为依据 | manifest 与图标已具备，其余见路线图 |
| D11 | 优先成熟第三方依赖 | 保持直接依赖版本固定 |
| D12 | 声明 `trustedHosts`，relay 原样转发 Host/Origin | 使用官方 browser-trust fence；远程设置由插件提供 |
| D13 | dsh 作为 launcher 的 npm 依赖分发 | 绿色包保留真实 node_modules，用户不必另装 dsh |
| D14 | 共用标准 DSH_HOME，仅隔离 dsh-remote-web profile | 共享 settings、credentials、sessions 与用户全局 patch |
| D15 | 非 loopback 浏览器请求统一登录 | 仅 loopback socket 与 loopback Host 同时成立才免登录 |
| D16 | 每台机器运行 dsh、relay、connector | 任意机器可作为远程入口，关系单向且每机最多一个入口 |
| D17 | 扩展放在 packages/plugins，各包自行说明 | 普通运行插件使用 overlay；简洁模式预设使用专属 Profile Bundle |
| D18 | Linux systemd 以个人普通用户运行整套 dsh-remote | 默认 `~/.dsh-remote` 保存 relay 运行数据，`~/.dsh` 保存官方 dsh 数据；普通操作使用用户权限，管理员操作由用户在交互终端输入 sudo，保留系统缓存；不主动建立 root shell |
| D19 | 公网使用泛子域名，本机保留 loopback，裸域名只进管理入口 | `https://<机器名>.<域名>` 保持每台机器独立 origin；`http://127.0.0.1:<端口>` 始终是本机入口；域名模式默认关闭成员端口，新增机器不改 DNS、证书或 TLS 反代；域名模式的公网 Cookie 与本机 HTTP 的 host-only 辅助 Cookie 分开 |
| D20 | 插件全部转为仓库内默认受管 Bundle（可停用）；npm 发布暂缓（本仓库可直接发） | 22 个插件（含简洁模式）转为 Profile Bundle：默认全开，用户可在 dsh 插件页停用（含停用 yolo 恢复 dsh 原生审批），托盘/`--restore-bundle` 补回；connection 的 webServer 注入是全部插件 RPC 的地基，自 remote-privileged 拆出为壳级常驻 overlay 不可停；npm 发布暂缓且路径为本仓库直接发布（无需拆仓，独立仓库仅组织性选项），等 Bundle 化与版本纪律就绪后再考虑；分批见 [插件可选化计划](plugin-optional-plan.md) |

## 2.05 术语

中文用户文案统一使用下表。代码标识符保持现有英文名称。

| 概念 | 用户可见名称 |
|---|---|
| 提供浏览器地址的机器 | 入口机器 |
| 该机器提供的访问地址 | 远程入口 |
| 挂在入口机器上的目标 | 通过 X 开放的机器 |
| 建立开放关系 | 把 X 挂到 Y 上；通过 Y 对外开放 |
| 目标机器自己取消关系 | 取消远程入口 |
| 入口机器取消目标资格 | 停止 X 并移除 |
| DNS 标签，如 pc2 | 机器名 |
| 页面中的当前机器 | 机器真名，如 pc1 |

`hub`、`MembershipHub`、`membership.json`、`slug`、`revoke` 等代码与 CLI 名称保持不变。
“吊销”用于登录会话和令牌。对机器使用“停止并移除”，因为它会令目标 connector 致命退出，
launcher 随之停掉 dsh 与 relay；恢复需要重新签发注册令牌。

> 每台机器都跑着自己的 dsh，AI 读写文件、执行命令都发生在那台机器上。
> 打开 pc2 的页面就是指挥 pc2；pc1 只负责转发。
> 把 pc2 挂到 pc1 上，表示可以从 pc1 的地址打开 pc2，反方向不成立。

## 2.1 拓扑与路由

relay 按以下顺序解析目标：子域名 → 持久化的每机器端口 → `directSlug`。
裸 `publicDomain` 只提供统一管理入口并跳转到 `/_admin`，不指向任何 dsh；子域名适合公网 HTTPS；每机器端口适合无域名的局域网；`directSlug` 指向入口机器自己的 dsh。
域名模式下 `directSlug` 仍由本机 loopback 地址提供，使用 `http://127.0.0.1:<relay-port>`，不改变本机控制台和 dsh 的访问方式。

`directSlug` 路由也经过 connector 控制信道，因此 relay 在 `serve` 启动时把本机挂到它自己
身上：membership.json 中写入带 `selfManaged` 标记的自挂条目并附一次性注册令牌，connector
拨 loopback 注册后，本机与局域网地址才能直达这台机器的 dsh。自挂条目由 relay 维护
（每次启动刷新；「取消远程入口」后由 relay 重建而不是清空），不属于操作员设置的远程入口，
launcher 的 banner 与 `--trusted-host` 都按「没有远程入口」处理它。

「取消远程入口」不会失忆：relay 把当时的 hub（去掉已用的一次性令牌）保存为 membership.json
的 `lastHub`，「远程入口」页据此提供一键「重新连接」。恢复不需要令牌——设备密钥仍在两侧，
hub 还认识这台机器时 connector 直接用密钥认证。重连被拒（设备已被入口「停止并移除」）时
connector 把条目降回 `lastHub` 并继续运行，而不是让整台机器停机；只有曾经认证成功后被吊销
仍整体退出，那正是「停止并移除」的既定语义。重新连接或设置新入口都会清掉 `lastHub`。

断开（含本机自挂之外没有入口）的机器以 `PROBE_INTERVAL_MS`（60 秒）周期向 `lastHub` 发送
带 probe 标记的唤醒探测：不承载流量、不进在线名单；入口有操作员「请求上线」（devices 表的
`wakeup_requested_at`，24 小时过期）时回 `reconnect-offer`，connector 恢复 `lastHub` 并由
launcher 自动重启 dsh。这补齐了入口与被断开机器之间唯一的唤醒通道，也让「机器」页能区分
「已断开·可唤醒」（近期有探测）与「离线」（探测也消失——关机或挂去了别的入口，无法区分）。
机器已「停止并移除」或 lastHub 被拒绝时探测停止并遗忘该入口。

端口不在 cookie 作用域内，因此同一主机不同端口共享登录态；配置 Cookie Domain 时子域也共享登录态。
域名模式的公网会话使用 `Domain=.<域名>` 的 Secure Cookie；真实 loopback 请求使用独立的非 Secure、host-only 辅助 Cookie，确保本机 HTTP 的 CSRF、主题和管理表单不依赖公网会话。
系统按同一管理员控制这些机器设计，不将端口当作用户隔离边界。

转发到目标 dsh 的 Host 是浏览器访问的机器 authority，目标 dsh 必须通过 `--trusted-host` 信任它。
域名模式下，connector 的控制地址使用公网裸域名（如 `wss://dsh.example.com`），目标 dsh 信任对应机器子域名（如 `pc2.dsh.example.com`）；从入口机器本机控制台签发命令时也必须生成这个可达的公网地址，不能把 `127.0.0.1` 打进命令。
入口地址变化后由 launcher 自动重启目标 dsh（连带 connector 上报新 token，relay 不动），并把进度写进
dsh-restart-status.json 供「远程入口」页展示；不需要操作员重启整个程序。

## 2.2 Profile 与插件装载

Bundle 顺序为 `dsh-base` → `dsh-web-app` → `dsh-plugin-concise-mode`。
最后一层仅向 `dsh-remote-web` 提供 `concise` 和 `concise-ptc` 预设。
locator 根据 `import.meta.url` 计算包内 preset root，不能依赖当前工作目录。

普通运行插件使用包根 `dsh-overlay.yml`，入口写 `./dist/index.js`，launcher 以 `--patch` 传入。
dsh 将相对路径锚定到 overlay 目录。宿主或浏览器构建产物缺失即拒绝启动。

launcher 为不存在的 profile 创建模板；受管 Bundle（当前只有简洁模式）只确保一次，
记录在 profile 内 `dsh-remote-bundles-state.json`——用户在 dsh 插件页停用后不再自动补回，
补回入口是托盘菜单「补回简洁模式」与 `--restore-bundle`。
第三方 Bundle 管理沿用官方 `dsh plugin --profile`。
内置插件不修改 home 全局 patch 或官方 `web` profile。

远程浏览器设置由 `remote-privileged` 注入 `ownsHost: true` 开放；它不替代 relay 认证，
不修改请求头。这个标志也会开放在目标机器桌面打开文件的动作，手机无法看到该桌面窗口。

## 3. 持续关注

- dsh 升级可能改变插件契约，按 [源码依据](02-dsh-facts.md) 和各插件检查脚本复核。
- relay 登录相当于取得目标机器用户权限下的 shell，风险与部署要求见 [安全](04-security.md)。
- 移动端真实长连接、后台恢复和附件上传需要实机验收，不能用单元测试代替。