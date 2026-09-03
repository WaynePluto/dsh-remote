# 部署示例：把一台机器变成常开的入口机器

这个目录里的两个文件，是给**需要 7×24 在线的入口机器（代码里叫 hub）**准备的——通常是一台
Linux 服务器：它自己跑 dsh，同时接住其他机器拨过来的隧道，并且是你在手机上
打开浏览器实际访问的那台。

| 文件 | 作用 |
|---|---|
| [`dsh-remote.service`](dsh-remote.service) | systemd unit 模板，用专用非特权用户跑启动器 |
| [`Caddyfile`](Caddyfile) | Caddy 在前面终结 TLS（泛域名 + apex），保留原始 Host |

## 先说清楚：你的台式机不需要这些

按 D16，每台装了 dsh-remote 的机器都是一样的：本机跑 dsh、一个中转服务、一个拨号器。
**被开放的机器（你桌上那台电脑、家里的笔记本）不需要 systemd，也不需要 Caddy 和域名**——
解压绿色包、跑启动脚本，然后在入口机器的控制台里签个令牌、粘到它自己的「远程入口」页就行，
全部步骤见仓库根目录的 [README.md](../README.md)。它不需要公网 IP，也不用做端口映射。

这个目录只解决一件事：**让当入口的那台机器在没人登录、重启之后也一直在线**。

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

## 步骤 1 · 建用户和目录

```bash
sudo useradd --system --create-home --home-dir /var/lib/dsh-remote \
  --shell /usr/sbin/nologin DshRemote

# dsh-remote home（relay.db / relay-jwt.secret / membership.json / device.key）
sudo install -d -o DshRemote -g DshRemote -m 0700 /var/lib/dsh-remote
# DSH_HOME：dsh 的 profiles / settings / credentials / sessions
sudo install -d -o DshRemote -g DshRemote -m 0700 /var/lib/dsh-remote/dsh
# 给 dsh 里的 agent 干活的目录
sudo install -d -o DshRemote -g DshRemote -m 0755 /srv/dsh-remote/workspace
# 配置文件目录
sudo install -d -o root -g root -m 0755 /etc/dsh-remote
```

⚠️ 这个用户的家目录**不要放在 `/home` 下**：unit 里开了 `ProtectHome=true`，
`/home` 和 `/root` 在服务眼里会变成空目录。

## 步骤 2 · 解压绿色包

```bash
sudo unzip dsh-remote-<版本>.zip -d /opt
sudo mv /opt/dsh-remote-<版本> /opt/dsh-remote
sudo chown -R root:root /opt/dsh-remote      # 程序目录保持只读

ls /opt/dsh-remote/dist                      # 应该能看到 index.js 和 relay.js
```

- `dist/index.js` 是启动器入口（unit 的 `ExecStart` 用它）
- `dist/relay.js` 是 relay 的命令行（下一步创建管理员用它）

从源码仓库部署也可以，两个路径换成
`packages/launcher/dist/index.js` 和 `packages/relay/dist/cli.js`（先 `pnpm install && pnpm build`）。

## 步骤 3 · 写配置文件

`/etc/dsh-remote/dsh-remote.config.json`：

```json
{
  "home": "/var/lib/dsh-remote",
  "dsh": {
    "port": 3080
  },
  "relay": {
    "host": "127.0.0.1",
    "port": 30809,
    "slug": "hub"
  }
}
```

| 字段 | 说明 |
|---|---|
| `home` | dsh-remote home。`relay.db` 默认就落在它下面，unit 的 `ReadWritePaths` 必须覆盖它 |
| `dsh.port` | dsh 的端口，**永远只 bind `127.0.0.1`**，不要放行到防火墙外 |
| `relay.host` | `127.0.0.1` = 只让本机的 Caddy 连得到；填 `0.0.0.0` 则局域网也能直连（明文 HTTP，见下） |
| `relay.port` | 控制台与隧道入口，默认 `30809` |
| `relay.slug` | 这台机器在自己控制台上的名字，只能是小写字母、数字和连字符 |

配置里**没有**「远程入口是谁」这一项：那是本机控制台的「远程入口」页写进 `membership.json` 的，
不在配置文件里配（D16）。

## 步骤 4 · 创建管理员（无头机器走 init）

正常情况下管理员是在**浏览器的设置向导**里创建的。但那个向导**只对 `127.0.0.1` 开放**：
局域网和远程访问只会看到一句「请到那台机器上完成设置」，拿不到任何表单。
云服务器上没有图形界面，你本地的浏览器也直接打不开它——所以无头机器上用 relay 的救急命令：

```bash
# 在启动服务之前做；如果服务已经在跑，先 sudo systemctl stop dsh-remote
sudo -u DshRemote node /opt/dsh-remote/dist/relay.js init \
  --data /var/lib/dsh-remote/relay.db
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
sudo -u DshRemote env DSH_REMOTE_ADMIN_PASSWORD='<至少12位的密码>' \
  node /opt/dsh-remote/dist/relay.js init --data /var/lib/dsh-remote/relay.db
```

> 顺带一提：如果你已经有 `ssh -L 30809:127.0.0.1:30809` 这样的端口转发，
> 浏览器设置向导其实也能用——转发过来的连接对 relay 来说 socket 和 Host 都是 loopback。
> 只是无头服务器上不该为了建个账号专门去架这个，`init` 更直接。

另外两条救急命令用法相同：`passwd`（重设密码）、`totp reset`（重置验证器）。
它们不带 `--username` 时会自动认库里唯一的那个账号，所以在设置向导里改过账号名也照样能用。
它们都不问旧密码——能在这台机器上执行命令的人本来就能直接读写数据库文件。
所以真正要守住的是**这台机器的 SSH 登录**。

## 步骤 5 · 装上 unit

先按 `dsh-remote.service` 顶部的注释把占位符改掉（用户名、三个目录、node 的绝对路径），
`command -v node` 能告诉你最后一个。

```bash
sudo install -m 0644 deploy/dsh-remote.service /etc/systemd/system/dsh-remote.service
sudo systemctl daemon-reload
sudo systemctl enable --now dsh-remote

systemctl status dsh-remote
journalctl -u dsh-remote -f
```

日志里应当依次出现 dsh 就绪、`relay listening`、以及启动器打印的地址框。

> `ProtectSystem=strict` 会把整个文件系统挂成只读，**只有 `ReadWritePaths` 里列出的路径可写**。
> 少列一条的典型后果是：relay 建不了 `relay.db`，服务起来又立刻挂掉。
> 特别注意 dsh 里的 agent 要改代码的目录也必须列进去，否则它一个字节都写不下去。

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

## 步骤 7 · 验证

```bash
# 1. 服务在跑
systemctl is-active dsh-remote

# 2. 日志里没有报错，能看到 relay listening
journalctl -u dsh-remote -n 50 --no-pager

# 3. 本机控制台（loopback socket + loopback Host 免登录）→ 200
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:30809/_admin

# 4. 经 Caddy 的 TLS 入口，未登录 → 302 跳转到 /_auth/login
curl -sS -o /dev/null -w '%{http_code}\n' https://dsh.example.com/_admin

# 5. 证书是真的（不是 Caddy 的内部 CA）
curl -sS -I https://dsh.example.com/_admin | head -1

# 6. 重启一次，确认开机自启和数据都还在
sudo systemctl restart dsh-remote && sleep 5 && systemctl is-active dsh-remote
```

第 3 条能通说明 relay 起来了；第 4 条能通说明 TLS 和反代链路是通的。

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

**通过域名用浏览器打开被开放的机器，现在还不能用。** 原因值得写清楚：

- relay 的域名模式由 `--domain <域名> --scheme https` 开启（`packages/relay/src/cli.ts`）。
  只有这时子域名才是路由键，cookie 才带 `__Secure-` 前缀和 `Domain=.<域名>`。
- 但启动器拉起本机 relay 时用的是固定参数
  `--scheme http --lan-http --direct-slug <slug>`（`packages/launcher/src/relay.ts`），
  还没把域名模式暴露成配置项。
- 在这种模式下，一个域名 Host 会被判为「不认识的机器」返回 404
  （`packages/relay/src/http/security.ts`），而 https 的 Origin 会被 CSRF 检查判为 403
  （`packages/relay/src/admin/shared.ts` 的 `sameOrigin`）——连登录都过不去。

所以现在这套文件的实际用法是：

| 想做什么 | 现在怎么办 |
|---|---|
| 让入口机器长期在线、开机自启 | ✅ 用这里的 `dsh-remote.service` |
| 让别的机器从外网拨进来 | ✅ 用这里的 `Caddyfile`：把注册命令里的 `--relay` 改成 `wss://dsh.example.com`（隧道的 `/_tunnel/*` 在任何 Host 校验之前处理，所以现在就能连上）<br>⚠️ 同一条命令里的 `--hub-authority` 要是你**实际用浏览器打开的那个地址**（例如 VPN 里的 `10.0.0.5`），它会变成那台 dsh 的 `--trusted-host` |
| 用浏览器打开入口机器和挂在它上面的机器 | ⏳ 暂时走 VPN / 内网 IP 直连，或 `ssh -L 30809:127.0.0.1:30809` 之后开 `http://127.0.0.1:30809` |
| 用 `https://<机器>.dsh.example.com` 访问 | ❌ 等启动器支持域名模式后即可，`Caddyfile` 不用改 |

顺带一提，域名模式一旦启用，被开放的机器就不再分配端口了（子域名成为唯一路由键），
书签需要从 `http://<IP>:<端口>` 换成 `https://<机器>.<域名>`。

## 备份与升级

- **要备份的是 `/var/lib/dsh-remote`**：`relay.db` 里有管理员、会话、设备公钥和审计日志；
  `relay-jwt.secret` 丢了不致命，只是所有浏览器要重新登录一次。
- `relay.db` 是 WAL 模式，运行中直接 `cp` 单个文件可能拿到不一致的快照。要么先停服务，
  要么用 `sqlite3 /var/lib/dsh-remote/relay.db ".backup '/备份路径/relay.db'"`。
- 升级：`sudo systemctl stop dsh-remote` → 换掉 `/opt/dsh-remote` 里的 `dist/` 和
  `node_modules/` → `sudo systemctl start dsh-remote`。
  配置和数据都在 `/etc/dsh-remote` 与 `/var/lib/dsh-remote`，不受影响。

## 相关文档

| 文档 | 内容 |
|---|---|
| [../README.md](../README.md) | 日常使用、加机器、救急命令 |
| [../docs/04-security.md](../docs/04-security.md) | 威胁模型、部署要求、显式接受的风险 |
| [../docs/06-packaging.md](../docs/06-packaging.md) | 绿色包结构与启动器职责 |
| [../docs/01-decisions.md](../docs/01-decisions.md) | D16（mesh 拓扑与三种路由键）等既定决策 |
