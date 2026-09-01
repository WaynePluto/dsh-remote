# M0.3 · 手机浏览器实测记录

> 状态：**待测**。这一项只能人工做，结论决定 M4 / M6 的范围。

## 怎么起服务

在 `d:\dev\dsh-remote` 下（PowerShell 7）：

```powershell
# 1. 查本机内网 IP
Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -like '192.168.*' -or $_.IPAddress -like '10.*' } | Select-Object IPAddress, InterfaceAlias

# 2. 仅限内网，用完立刻 Ctrl+C
node --import ./packages/launcher/dist/proxy-bootstrap.js packages\launcher\node_modules\@deepseek-ai\dsh\lib\bin.js --profile dsh-remote-web --no-open --host 0.0.0.0 --port 3080 --trusted-host <你的内网IP>:3080
```

⚠️ 此时 dsh 在内网上**没有任何认证**（官方原话：`there is no TLS, auth, or origin policy`）。测完立刻停掉。
⚠️ Windows 防火墙可能拦 3080，第一次运行会弹窗，选「专用网络」放行。
ℹ️ dsh CLI 对 `--host 0.0.0.0` 会自行推导本机 LAN IP 加进信任列表，`--trusted-host` 可能不是必须的；若不加就 403，再加上。

手机连同一 WiFi，浏览器打开 `http://<你的内网IP>:3080`。

## 前置条件

需要先配好 DeepSeek API Key，否则只能看界面不能对话。首次打开界面里配（loopback 访问时设置页可用），或直接在 PC 浏览器 `http://127.0.0.1:3080` 里配好再用手机测。

## 观察清单（请逐条填）

| # | 观察项 | 结果 | 备注 |
|---|---|---|---|
| 1 | 首屏加载耗时 | | |
| 2 | 侧边栏（会话列表）在小屏上是否可用 | | 会不会挡住主区、能否收起 |
| 3 | 输入框是否可用 | | 软键盘弹出后布局是否被顶乱 |
| 4 | 消息流 / 流式输出是否正常 | | |
| 5 | 代码块、diff 是否能横向滚动 | | |
| 6 | 审批卡片（`ui-permission-presets`）能否点 | | 触发方式：让它执行一个需要批准的命令 |
| 7 | 用户提问卡片（`ui-user-questions`）能否点 | | |
| 8 | 模型选择器能否用 | | |
| 9 | 切到别的 App 再回来，会话是否自动恢复 | | dsh 自己会重建两个下行 WS |
| 10 | 锁屏几分钟后回来是否还能用 | | |
| 11 | 整体可用性打分（1-5） | | |

## 决策点

- **可用（≥3 分）** → M4 只做 PWA + 推送，不写自定义 UI
- **不可用（<3 分）** → M6 需要写 `dsh.client` 插件替换 layout，工作量 +约 2 周

## 结论

（测完写在这里）
