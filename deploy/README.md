# 部署示例：把一台机器变成常开的入口机器

这个目录里的两个文件，是给**需要 7×24 在线的入口机器（代码里叫 hub）**准备的——通常是一台
Linux 服务器：它自己跑 dsh，同时接住其他机器拨过来的隧道，并且是你在手机上
打开浏览器实际访问的那台。

| 文件 | 作用 |
|---|---|
| [`dsh-remote.service`](dsh-remote.service) | systemd unit 模板，用个人普通用户跑启动器 |
| [`Caddyfile`](Caddyfile) | Caddy 在前面终结 TLS（泛域名 + apex），保留原始 Host |

## 先说清楚：你的台式机不需要这些

按 D16，每台装了 dsh-remote 的机器都是一样的：本机跑 dsh、一个中转服务、一个拨号器。
**被开放的机器（你桌上那台电脑、家里的笔记本）不需要 systemd，也不需要 Caddy 和域名**——
解压绿色包、跑启动脚本，然后在入口机器的控制台里签个令牌、粘到它自己的「远程入口」页就行，
全部步骤见仓库根目录的 [README.md](../README.md)。它不需要公网 IP，也不用做端口映射。

这个目录只解决一件事：**让当入口的那台机器在没人登录、重启之后也一直在线**。

本部署模式让 launcher、dsh、relay、connector 以你的个人普通用户运行：dsh 默认从个人家目录开始，
普通命令使用该用户权限；需要管理员权限时，由你在网页交互终端里输入 sudo 密码。它不是 root 服务，
也不把 sudo 密码交给 dsh-remote 保存。

## 一个服务，三个进程

一台 dsh-remote 机器同时跑三个进程：dsh、relay（中转 + 控制台）、connector（拨号器）。
它们由**一个启动器进程**拉起来并按顺序关掉，所以：

> **只给启动器写一个 unit，不要给 dsh / relay / connector 分别写三个。**

启动器不会偷偷重启子进程：任一子进程意外退出时，它会打印那个子进程最后 50 行日志，
把其余进程一起停干净，然后自己退出。**把服务重新拉起来的是 systemd 的 `Restart=always`。**

## 准备

- Linux + systemd
- **Node.js 22.19.0 或更高**（`node -v` 确认；低于这个版本启动器会直接报错退出）
- 一个域名和能改 DNS 记录的 API token（只有需要 HTTPS 域名访问时才要）

运行时**没有任何原生模块**，不需要编译工具链，但 Node 必须装在这台机器上——
绿色包不携带 Node 二进制。

## 步骤 1 · 准备个人用户和目录

这份 unit 不创建专用系统用户。先确定一名日常使用的普通用户和它的主组：

```bash
id <user>
getent passwd <user>
```

把 unit 顶部的 `<user>` 和 `<group>` 替换成实际值。个人用户的家目录必须已经存在，且服务启动时可以访问。
如果这是从旧 `/var/lib/dsh-remote` 部署迁移，先跳到下面的迁移章节，不要先创建目标目录。

```bash
# dsh-remote home（relay.db / relay-jwt.secret / membership.json / device.key）
sudo install -d -o <user> -g <group> -m 0700 /home/<user>/.dsh-remote
# 官方 dsh 的标准 DSH_HOME；已有目录不要覆盖其中的设置、凭据或会话
if [ ! -d /home/<user>/.dsh ]; then
  sudo install -d -o <user> -g <group> -m 0700 /home/<user>/.dsh
fi
# 配置文件目录
sudo install -d -o root -g root -m 0755 /etc/dsh-remote
```

运行数据和 dsh 数据是两个不同目录：

```text
/home/<user>/.dsh-remote/   relay.db、relay-jwt.secret、membership.json、device.key
/home/<user>/.dsh/          dsh profiles、settings、credentials、sessions
```

程序仍放在 `/opt/dsh-remote`，工作目录是 `/home/<user>`。unit 显式关闭 `ProtectHome`、
`NoNewPrivileges` 和 `ProtectSystem`，让服务看到与该用户通过 SSH 登录时相近的文件系统和 sudo 能力。
这也意味着默认 YOLO 下，远程模型可以使用该普通用户本来就能访问的个人文件；公网部署仍必须使用 HTTPS/WSS。

## 已有 `/var/lib/dsh-remote` 部署的迁移

如果服务器以前按旧模板使用了 `/var/lib/dsh-remote`，先停服并备份，再分别迁移两类数据。
不要把旧目录整体复制成 `~/.dsh-remote/dsh`：官方 dsh 的数据目标是 `~/.dsh`。

迁移前确认两个目标目录不存在（如果之前创建了空目录，也先移除）；如果 `~/.dsh` 已有数据，不要自动覆盖或合并，先保留旧服务或人工制定合并方案。
以下命令中的 `<user>`、`<group>` 替换为服务用户：

```bash
sudo systemctl stop dsh-remote
sudo cp -a /var/lib/dsh-remote /var/lib/dsh-remote.backup

# 目标目录已有内容时停止，不要覆盖已有凭据、设置或会话
if [ -e /home/<user>/.dsh-remote ] || [ -e /home/<user>/.dsh ]; then
  echo '目标目录已存在，请先备份并人工确认是否合并' >&2
  exit 1
fi
sudo install -d -o <user> -g <group> -m 0700 /home/<user>/.dsh-remote
sudo install -d -o <user> -g <group> -m 0700 /home/<user>/.dsh

# relay 数据：复制旧目录的顶层内容，但不把旧的 dsh/ 嵌套进新的 dsh-remote home
sudo find /var/lib/dsh-remote -mindepth 1 -maxdepth 1 ! -name dsh -exec cp -a {} /home/<user>/.dsh-remote/ \;
# dsh 数据：旧目录下的 dsh/ 直接成为标准 ~/.dsh/
sudo cp -a /var/lib/dsh-remote/dsh/. /home/<user>/.dsh/
sudo chown -R <user>:<group> /home/<user>/.dsh-remote /home/<user>/.dsh
sudo chmod 700 /home/<user>/.dsh-remote /home/<user>/.dsh
```

然后更新 unit 的 `HOME`、`DSH_HOME`、`WorkingDirectory` 和配置中的 `home`，再按下面步骤启动。
验收管理员、机器关系、dsh 设置、凭据、会话和目录选择都正常后，才决定是否删除旧备份。
SQLite 迁移必须在服务停止后进行；如果服务曾异常退出，先确认没有残留 launcher、dsh、relay 或 connector 进程。

## 步骤 2 · 解压绿色包

zip 条目直接放在压缩包根目录、没有版本目录层，所以先建好目标目录再往里解压
（文件名里的 `linux-x64` 是平台段，别下错平台的包）：

```bash
sudo mkdir -p /opt/dsh-remote
sudo unzip dsh-remote-<版本>-linux-x64.zip -d /opt/dsh-remote
sudo chown -R root:root /opt/dsh-remote      # 程序目录保持只读

ls /opt/dsh-remote/dist                      # 应该能看到 index.js 和 relay.js
```

- `dist/index.js` 是启动器入口（unit 的 `ExecStart` 用它）
- `dist/relay.js` 是 relay 的命令行（下一步创建管理员用它）

从源码仓库部署也可以，两个路径换成
`packages/launcher/dist/index.js` 和 `packages/relay/dist/cli.js`（先 `pnpm install && pnpm build`）。

## 步骤 3 · 写配置文件

启用公网域名时先做一次 DNS 配置，之后新增机器不再增加记录：

```text
dsh.example.com       A    <入口机器公网 IP>
*.dsh.example.com     A    <入口机器公网 IP>
```

TLS 证书同时覆盖 `dsh.example.com` 和 `*.dsh.example.com`。DNS-01 能签发泛域名证书；不要为每台机器单独申请证书。

`/etc/dsh-remote/dsh-remote.config.json`：

```json
{
  "home": "/home/<user>/.dsh-remote",
  "dsh": {
    "port": 3080
  },
  "relay": {
    "host": "127.0.0.1",
    "port": 30809,
    "slug": "hub",
    "domain": "dsh.example.com"
  }
}
```

这份示例配合下方 Caddyfile：机器地址形如 `https://hub.dsh.example.com`，统一入口是 `https://dsh.example.com`。
把 `domain` 配成更上层的根域（如 `example.com`）也完全可以，机器地址就变成 `https://<机器名>.example.com`，证书与 DNS 记录按同样的层级准备即可。
域名模式下本机仍可用 `http://127.0.0.1:30809` 完整打开管理页和本机 dsh；它使用独立的本机 Cookie，不要求公网域名链路可达。

| 字段 | 说明 |
|---|---|
| `home` | dsh-remote home，个人模式建议使用 `/home/<user>/.dsh-remote`；`relay.db` 默认落在它下面 |
| `dsh.port` | dsh 的端口，**永远只 bind `127.0.0.1`**，不要放行到防火墙外 |
| `relay.host` | `127.0.0.1` = 只让本机的 Caddy/nginx 连得到；填 `0.0.0.0` 则局域网也能直连（明文 HTTP，见下）。配置了 `domain` 时必须留空或填 `127.0.0.1`，launcher 会拒绝其他值 |
| `relay.port` | 控制台与隧道入口，默认 `30809` |
| `relay.slug` | 这台机器在自己控制台上的名字，只能是小写字母、数字和连字符 |
| `relay.domain` | **要用域名访问就得配**：公网根域（如 `dsh.example.com`）。设置后 relay 以域名模式运行，裸域名只进入 `/_admin`，每台机器的地址是 `https://<机器名>.<域名>`——这台机器自己的地址由 `slug` 决定；从本机控制台签发的 connector 命令会使用 `wss://<域名>`，不会把 `127.0.0.1` 作为远端地址。不设置则只有明文局域网 HTTP 模式，域名访问不可用 |

配置里**没有**「远程入口是谁」这一项：那是本机控制台的「远程入口」页写进 `membership.json` 的，
不在配置文件里配（D16）。

## 步骤 4 · 创建管理员（无头机器走 init）

正常情况下管理员是在**浏览器的设置向导**里创建的。但那个向导**只对 `127.0.0.1` 开放**：
局域网和远程访问只会看到一句「请到那台机器上完成设置」，拿不到任何表单。
云服务器上没有图形界面，你本地的浏览器也直接打不开它——所以无头机器上用 relay 的救急命令：

```bash
# 以 unit 中配置的个人用户执行；如果服务已经在跑，先 sudo systemctl stop dsh-remote
node /opt/dsh-remote/dist/relay.js init \
  --data /home/<user>/.dsh-remote/relay.db
```

它会：

1. 提示你输入两遍管理员密码（**至少 6 个字符，且用上大写字母、小写字母、数字、符号里的至少 3 类**，
   需要一个真正的终端；用户名默认 `admin`，要改用 `--username <名字>`；名字只能用字母、数字和 `. _ -`）
2. 打印一条 `otpauth://…` 的 TOTP URI，把它添加到验证器 App（Microsoft Authenticator、
   Google Authenticator、1Password 都行）
3. 之后从浏览器登录就是「密码 + 6 位动态码」

> 🔒 这条 URI 就是你的验证器密钥。**不要贴到在线二维码网站。**
> 想要二维码就在本机生成，例如 `qrencode -t ANSIUTF8 'otpauth://…'`。

如果非要脚本化（不推荐，密码会进入进程表和 shell 历史）：

```bash
env DSH_REMOTE_ADMIN_PASSWORD='<至少12位的密码>' \
  node /opt/dsh-remote/dist/relay.js init --data /home/<user>/.dsh-remote/relay.db
```

> 顺带一提：如果你已经有 `ssh -L 30809:127.0.0.1:30809` 这样的端口转发，
> 浏览器设置向导其实也能用——转发过来的连接对 relay 来说 socket 和 Host 都是 loopback。
> 只是无头服务器上不该为了建个账号专门去架这个，`init` 更直接。

另外两条救急命令用法相同：`passwd`（重设密码）、`totp reset`（重置验证器）。
它们不带 `--username` 时会自动认库里唯一的那个账号，所以在设置向导里改过账号名也照样能用。
它们都不问旧密码——能在这台机器上执行命令的人本来就能直接读写数据库文件。
所以真正要守住的是**这台机器的 SSH 登录**。

## 步骤 5 · 装上 unit

先按 `dsh-remote.service` 顶部的注释把占位符改掉（用户名、用户组、各个路径、node 的绝对路径），
`command -v node` 能告诉你最后一个。确认 `/home/<user>/.dsh-remote` 和 `/home/<user>/.dsh` 都由该用户拥有，
再安装 unit；不要把 `<user>` 填成 `root`。

```bash
sudo install -m 0644 deploy/dsh-remote.service /etc/systemd/system/dsh-remote.service
sudo systemctl daemon-reload
sudo systemctl enable --now dsh-remote

systemctl status dsh-remote
journalctl -u dsh-remote -f
```

日志里应当依次出现 dsh 就绪、`relay listening`、以及启动器打印的地址框。

> 这是个人用户模式，unit 没有 `ProtectHome`、`NoNewPrivileges`、`ProtectSystem` 或 `ReadWritePaths` 的旧式限制。
> dsh 的可访问范围由个人用户的 Unix 权限、挂载状态和 sudoers 决定；sudo 密码只在交互终端由你输入，
> dsh-remote 不保存密码，也不主动建立 root shell。

## 步骤 6 · 前面放 Caddy

先读 [`Caddyfile`](Caddyfile) 顶部的注释——**它对 relay 的运行模式有前提要求**，
见下面的「现状与限制」。

```bash
sudo install -m 0644 deploy/Caddyfile /etc/caddy/Caddyfile

# DNS API token 放进 caddy 服务的环境变量，不要写进 Caddyfile
sudo systemctl edit caddy
#   [Service]
#   Environment=CADDY_DNS_TOKEN=<你的 DNS API token>

sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl reload caddy
```

泛域名证书只能走 DNS-01 挑战，**需要一份带对应 DNS 插件的 Caddy**
（`xcaddy build --with github.com/caddy-dns/<provider>`，或官方下载页的 custom build）。
Caddy 默认保留原始 Host、默认正确处理 WebSocket 升级，这正是 relay 需要的：
它靠 Host 判断该路由到哪台机器，而模式 A 会把这个 Host 原样转发给被开放机器的 dsh。
站点必须只匹配 `dsh.example.com` 与 `*.dsh.example.com`，不要让无条件默认站点把外部请求的 loopback/IP Host 转发进 relay；否则可能误触本机免登录入口。

## 步骤 7 · 验证

```bash
# 1. 服务在跑
systemctl is-active dsh-remote

# 2. 日志里没有报错，能看到 relay listening
journalctl -u dsh-remote -n 50 --no-pager

# 3. 本机控制台（loopback socket + loopback Host 免登录）→ 200
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:30809/_admin

# 4. 经 TLS 入口的域名请求 → 302 到登录页（_auth/login）
curl -sS -o /dev/null -w '%{http_code} %{redirect_url}\n' https://hub.dsh.example.com/_admin

# 5. 裸域名只进入管理入口（已登录后为 302 到 /_admin）
curl -sS -o /dev/null -w '%{http_code} %{redirect_url}\n' https://dsh.example.com/

# 6. 证书是真的（不是反代的内部 CA）
curl -sS -I https://hub.dsh.example.com/_admin | head -1

# 7. 重启一次，确认开机自启和数据都还在
sudo systemctl restart dsh-remote && sleep 5 && systemctl is-active dsh-remote
```

第 3 条能通说明 relay 起来了；第 4 条拿到 302 说明 TLS、反代与域名模式三者接上了，
第 5 条确认裸域名没有隐式指向某台 dsh。浏览器打开 `https://dsh.example.com/` 输入管理员密码和动态码即可进入控制台，
再从机器列表打开 `https://<机器名>.dsh.example.com/`。

> ⚠️ 第 3 条同时说明：**任何能在这台机器上开 loopback 连接的人都免登录**，
> 包括通过 `ssh -L 30809:127.0.0.1:30809` 转发出去的浏览器。
> 这是 D15 明确接受的取舍（能在这台机器上执行命令的人本来就能读数据库），
> 但它意味着这台机器的 SSH 权限等价于 dsh-remote 的管理员权限。

## 防火墙

```bash
sudo ufw allow 80/tcp     # http -> https 跳转
sudo ufw allow 443/tcp
sudo ufw status
```

- **不要把 `30809` 放行到公网**：relay 自己不做 TLS，那是明文 HTTP 的登录页。
  它只该被本机的 Caddy 连到，所以配置里 `relay.host` 填 `127.0.0.1`。
- **dsh 的 `3080` 永远不要放行**：dsh 自身没有任何认证，只 bind `127.0.0.1`。
- 如果你走的是「内网 / VPN 直连」那条路（`relay.host` 填 `0.0.0.0`），
  需要放行的是 `30809` 和机器端口段 `30810-30873`
  （每台挂上来的机器分一个，默认从主端口 +1 开始，共 64 个）。
  这条路是明文 HTTP，relay 启动时会打印 `HIGH RISK` 告警，**只能在 VPN 或可信内网里用**。

## 现状与限制

**通过域名用浏览器打开机器，要求配置文件里写了 `relay.domain` 且 TLS 反代原样保留 Host。**
DNS 只需一次配置 `dsh.example.com` 和 `*.dsh.example.com` 指向入口；新增机器不新增 DNS、证书或 Caddy/nginx 路由。
两件事都做对后整条链路可用：

- launcher 读到 `relay.domain` 后，让 relay 以域名模式启动（`--domain <域名> --scheme https`，
  `packages/launcher/src/relay.ts`）：子域名成为机器路由键，会话 cookie 是
  `__Secure-` 前缀加 `Domain=.<域名>`，成员机器不再默认分配独立端口；裸域名只进入管理入口。
- 同时 launcher 把 `<slug>.<域名>` 写进 dsh 的 `--trusted-host`，并把
  `relay.host` 固定为 `127.0.0.1`（公网流量必须先过 TLS 反代；显式配置其他
  地址会被拒绝）。
- **没配 `relay.domain` 的机器**：relay 以明文局域网 HTTP 模式运行，域名 Host
  会得到 404、https Origin 会得到 403——那台机器只能用 IP / localhost / VPN 直连访问。

| 想做什么 | 现在怎么办 |
|---|---|
| 让入口机器长期在线、开机自启 | ✅ 用这里的 `dsh-remote.service` |
| 用 `https://<机器>.<域名>` 访问 | ✅ 配置 `relay.domain` + 泛域名 DNS/证书 + TLS 反代（见上文） |
| 让别的机器从外网拨进来 | ✅ 注册命令里的 `--relay` 用 `wss://<域名>`；域名模式下签发的命令会自动带上正确的 `--hub-authority <机器>.<域名>`，粘到对方控制台即可 |
| 没有域名 / 不想上 TLS | 内网或 VPN 直连：目标机器不配 `domain`，`relay.host` 用 `0.0.0.0`，放行 `30809` 和机器端口段 `30810-30873`（明文 HTTP，启动时会打印 `HIGH RISK` 告警，**只能在 VPN 或可信内网里用**），或 `ssh -L 30809:127.0.0.1:30809` 之后开 `http://127.0.0.1:30809` |

启用域名模式后，被开放的机器不再默认分配端口（子域名是唯一路由键），
书签需要从 `http://<IP>:<端口>` 换成 `https://<机器>.<域名>`；入口机器本机仍可用 `http://127.0.0.1:<relay-port>`，不应把这个 loopback 地址复制给其他机器作为 connector 的 `--relay` 地址。

## 备份与升级

- **要备份的是 `/home/<user>/.dsh-remote` 和 `/home/<user>/.dsh`**：前者的 `relay.db` 里有管理员、会话、设备公钥和审计日志，
  后者保存 dsh 的 profiles、设置、凭据和会话；`relay-jwt.secret` 丢了不致命，只是所有浏览器要重新登录一次。
- `relay.db` 是 WAL 模式，运行中直接 `cp` 单个文件可能拿到不一致的快照。要么先停服务，
  要么用 `sqlite3 /home/<user>/.dsh-remote/relay.db ".backup '/备份路径/relay.db'"`。
- 升级：停服务后把整个目录挪开留作回滚，再往新目录解压新版 zip：

  ```bash
  sudo systemctl stop dsh-remote
  sudo mv /opt/dsh-remote /opt/dsh-remote-<旧版本>    # 出问题时改回名字即回滚
  sudo mkdir -p /opt/dsh-remote
  sudo unzip dsh-remote-<新版本>-linux-x64.zip -d /opt/dsh-remote
  sudo chown -R root:root /opt/dsh-remote
  sudo systemctl start dsh-remote
  ```

  不要在原目录里解压覆盖：不带 `-o` 的 unzip 会逐个文件询问要不要替换，
  带了也会把上游已删除的旧文件留在 `node_modules` 里。
  配置和数据都在 `/etc/dsh-remote`、`/home/<user>/.dsh-remote` 与 `/home/<user>/.dsh`，不受影响。

## 相关文档

| 文档 | 内容 |
|---|---|
| [../README.md](../README.md) | 日常使用、加机器、救急命令 |
| [../docs/04-security.md](../docs/04-security.md) | 威胁模型、部署要求、显式接受的风险 |
| [../docs/06-packaging.md](../docs/06-packaging.md) | 绿色包结构与启动器职责 |
| [../docs/01-decisions.md](../docs/01-decisions.md) | D16（mesh 拓扑与三种路由键）等既定决策 |
