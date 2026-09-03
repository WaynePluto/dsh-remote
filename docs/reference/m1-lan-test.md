# M1.5 局域网端到端联调清单

> 目标：在一台机器上跑 relay + connector + dsh，先用本机访问局域网 IP 排掉配置问题，再用手机或第二台机器确认真实链路。
> 结论请回填到本文件末尾的「实测结果」。

## 0. 一次性准备

```powershell
cd d:\dev\dsh-remote
pnpm install
pnpm relay:init          # 创建管理员，打印 TOTP URI
```

`relay:init` 会输出 `otpauth://totp/dsh-remote:admin?...`，用手机验证器（如 Google Authenticator）扫码或手动添加。
**这一步只需做一次**，密钥和数据库都在 `.dev/`，已被 git 忽略。

想跳过交互式输入时（仅限本地调试）：

```powershell
$env:DSH_REMOTE_ADMIN_PASSWORD = '你的密码'; pnpm relay:init; Remove-Item Env:DSH_REMOTE_ADMIN_PASSWORD
```

密码至少 6 个字符，且大写字母、小写字母、数字、符号四类里至少占三类。忘密码或丢验证器见§6。

## 1. 启动

| 场景 | 命令 |
|---|---|
| 本地调试（tsx 直跑源码，改代码重启即可） | `pnpm dev` |
| 本地打包 | `pnpm build` |
| 启动打包版本（跑 `dist/`，验证发布形态） | `pnpm start` |

三个进程由 `scripts/dev-stack.mjs` 统一拉起并打印地址：

- dsh：`127.0.0.1:3080`，profile `dsh-remote-web`，`--trusted-host` 自动带上 `127.0.0.1` / `localhost` / 本机局域网 IP
- relay：`0.0.0.0:30809`，`--direct-slug pc1 --scheme http --lan-http`
- connector：连 `ws://127.0.0.1:30809`，转发到本地 dsh

`Ctrl+C` 会用 `taskkill /T /F` 结束整棵进程树。

⚠️ `--lan-http` 是**显式的高危开发模式**：明文 HTTP 下密码和 session cookie 可被同网段监听。启动时会打印 `HIGH RISK` 警告。用完就关，不要长期开着。

## 2. 本机自测（先做这一轮）

浏览器打开 `http://<本机局域网IP>:30809`（地址由启动日志打印）。

> 用命令行验证时注意：如果配了公司代理，`Invoke-WebRequest` 会走代理并返回代理的拦截页。必须加 `-NoProxy`。

> 标有 ☑︎ 的条目已由命令行或自动化测试覆盖，不需要手工重做；其余需要浏览器实操。

- [x] ☑︎ 未登录访问任意页面 → 302 跳到 `/_auth/login`
- [x] ☑︎ 未登录 `POST /api/<method>` → 401
- [ ] 登录页能正常显示，手机屏幕宽度下不错位
- [x] ☑︎ 用错误密码或错误验证码登录 → 提示「账号、密码或动态验证码不正确」
- [ ] 连续输错 5 次 → 提示登录尝试过多（15 分钟锁定）
- [x] ☑︎ 正确密码 + 验证器动态码 → 登录成功并跳回原页面
- [x] 登录后 cookie 是 `dsh_access` / `dsh_refresh`，含 `HttpOnly`，**不含** `Secure`（实测通过）
- [x] ☑︎ 前端 dist 正常加载，不是 403
- [x] `/plugins/*/client.js` 全部 200（实测通过）
- [x] ☑︎ 两个下行 WebSocket `/api/events.mux`、`/api/events.host` 都是 101
- [x] ☑︎ 能发消息并看到流式输出
- [x] 能切换会话、创建新会话（实测通过）
- [ ] 上传一张图片附件成功（验证大 body 转发）
- [x] ☑︎ 本机用 `http://127.0.0.1:30809` 访问 → 直接可用，不需要登录（loopback 豁免）
- [x] ☑︎ 设置页/凭据页返回 403，控制台出现 `settings.describe` / `credentials.describe` 报错，
      模型页提示「加载提供方目录失败」—— **这是模式 A 的预期行为，不是 bug**。
      dsh 把 15 个特权方法钉死在 loopback（docs/02 §4.2），模式 A 原样转发 Host，局域网必然被拒。
      模型与凭据在本机 `http://127.0.0.1:30809` 配好即可；远程只做“看进度 + 发指令 + 批准”。

## 3. 断线恢复

- [x] 杀掉 connector 进程后重启 `pnpm dev` → 页面刷新即可继续用（实测通过）
- [x] ☑︎ 关掉 relay 再启动 → connector 自动重连（日志出现 `control channel authenticated`）
- [ ] 挂着页面 30 分钟以上，两个 WebSocket 不断

## 3.5 设备认证（M2.2，已全部自动验证）

静态 token 已彻底移除，connector 用 Ed25519 设备密钥签名挑战登录。
开发密钥在 `.dev/device.key`，**不会影响**真实安装的 `~/.dsh-remote/device.key`；`pnpm dev` 自动完成首次注册。

想自己复现时（可选）：

```powershell
# 查看已注册设备
node --import tsx packages/relay/src/cli.ts device list --data .dev/relay.db

# 停止并移除后用现有密钥直连（不带注册令牌）→ 应得到 DEVICE_REVOKED 且退出码 1
node --import tsx packages/relay/src/cli.ts device revoke <machineId> --data .dev/relay.db
node --import tsx packages/connector/src/cli.ts --relay ws://127.0.0.1:30809 --slug pc1 --dsh-port 3080 --device-key .dev/device.key

# 恢复：重启开发栈会自动重新注册
```

已知缺口：`device revoke` **CLI 子命令**跑在独立进程里，不会断开已建立的连接，只保证无法重连。
需要「立即断开」时请用管理页（见 §3.6），它跑在运行中的 relay 里。

## 3.6 管理页（M2.5，已自动验证）

浏览器打开 `http://<地址>:30809/_admin`（登录后，或本机 loopback 免登录）。
控制台是三个页面，顶部一行 tab 切换：`/_admin` 机器、`/_admin/hub` 远程入口、
`/_admin/account` 账号。（本文当时还有第四页 `/_admin/audit` 活动，后来删了：
安全记录只留在 `relay.db` 和 pino 日志里）

- 「我的机器」列表（`/_admin`）：slug、machineId、在线/离线/已停止并移除、注册与更新时间、入口链接
- 「停止 <机器名> 并移除…」：先跳确认页（GET 同路径，无副作用），确认后才**当场断开**控制信道，
  connector 收到 `DEVICE_REVOKED` 后致命退出；用启动器跑的机器会连带把自己的 dsh 一起停掉
- 机器离线时浏览器导航得到友好的 502 页；API 请求仍是纯文本
- 页脚「退出登录」：跳 `/_auth/logout` 确认页，确认后服务端撤销会话并跳回登录页
  （loopback 免登录访问时不显示这个入口——那种请求没有会话可退）

实测日志（三条互相印证）：

```text
relay:     machine disconnected by operator   code=DEVICE_REVOKED  disconnected:true
connector: relay reported a tunnel error      code=DEVICE_REVOKED
connector: connector stopped and will not retry
```

注意：开发栈下 connector 致命退出会连带停掉整个 `pnpm dev`（这是 dev-stack 的设计），
重启即可：它会发现设备已被移除并自动重新注册。

## 4. 手机 / 第二台机器（本机测不出来的部分）

前置：两台设备连同一 WiFi，且 Windows 防火墙放行 30809 入站。

```powershell
# 需要管理员权限；用完删掉规则
New-NetFirewallRule -DisplayName 'dsh-remote dev 30809' -Direction Inbound -LocalPort 30809 -Protocol TCP -Action Allow
Remove-NetFirewallRule -DisplayName 'dsh-remote dev 30809'
```

- [ ] 手机能打开 `http://<局域网IP>:30809` 并跳转登录页
- [ ] 手机上能完成登录（含验证器动态码）
- [ ] 首屏加载耗时可接受
- [ ] 布局可用：侧边栏、输入框、消息流不挤成一团
- [ ] 审批卡片在小屏上能点
- [ ] 切到别的 App 再回来，会话自动恢复
- [ ] 锁屏几分钟后回来，WebSocket 能恢复

后四项同时也是 M0.3 的验收内容，结果请一并回填到 `docs/reference/mobile-test.md`。

## 5. 收尾

- [ ] `Ctrl+C` 后 `netstat` 确认 30809 和 3080 都已释放，没有孤儿进程
- [ ] 删除临时防火墙规则

## 6. 忘密码 / 丢验证器怎么办

两条命令都需要能访问数据库文件（即本机或服务器 SSH），因此不需要旧凭据；两者都会**吊销全部现有登录会话**。

| 情况 | 本地开发 | 发布后（服务器） |
|---|---|---|
| 改密码 | `pnpm relay:passwd` | `dsh-remote-relay passwd --data <db>` |
| 验证器丢了 | `pnpm relay:totp-reset` | `dsh-remote-relay totp reset --data <db>` |

- `passwd` 只改密码，**验证器不变**
- `totp reset` 只换验证器，**密码不变**；打印新 URI，下次登录输入新动态码即完成绑定（记得先在验证器里删掉旧条目，否则两条同名记录容易拿错）

## 实测结果

| 项目 | 结论 | 备注 |
|---|---|---|
| 本机局域网 IP 自测 | 通过 | 会话切换/新建、cookie 属性、插件脚本 均实测通过 |
| 断线恢复 | 部分通过 | 杀 connector 后重启可恢复；>30min 长连接尚未验证 |
| 手机实测 | 未做 | 需防火墙放行 30809；同时是 M0.3 验收 |
| 附件上传 | 未做 | 唯一未验证的大 body 转发路径 |
| 登录限流 | 未做 | |
