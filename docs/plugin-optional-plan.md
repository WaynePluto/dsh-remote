# 插件可选化计划

**仓库内 Bundle 化已全部实施**——22 个插件（含简洁模式）都是用户可停用的默认受管
Profile Bundle；remote-privileged 拆成壳级 connection 注入（不可停）与 remote-settings
受管 Bundle。「npm 发布」「独立仓库」与「壳配置化引用」**暂缓，以后再考虑**，
相关设计保留在文末备查；发布路径已明确为**本仓库直接发布**，不需要拆仓。
决策记录见 [01-decisions](01-decisions.md) D20。代码完成≠验收完成：实机验收清单见下。

## 已实施结果（2026-09-22 实施完成）

- **统一语义**：停用 = dsh 插件页把包名移出 `dsh.profile.bundles`；launcher 对受管
  Bundle 只确保一次（profile 内 `dsh-remote-bundles-state.json`），此后尊重停用；
  补回 = 托盘菜单或 `--restore-bundle`。
- **每个插件包**：`dsh-overlay.yml` 改名为 `cordis.patch.yml`，package.json 声明
  `dsh.bundle.patch` 并把它列入 `files`；README 增加「停用与补回」一节。
- **权威清单**在 `packages/launcher/src/dsh-plugins.ts`：
  `SHELL_PLUGIN_PACKAGES`（仅 remote-privileged 的 connection 注入 overlay）与
  `MANAGED_PLUGIN_PACKAGES`（22 个受管 Bundle，顺序即层序：远程设置在前、
  代理先于其他出网插件、固定 YOLO 固定末位）。profile.ts 据此导出
  `MANAGED_PLUGIN_BUNDLES` 与默认模板；`scripts/local-config.mjs`
  （`DEFAULT_PROFILE_BUNDLES`）与 `scripts/pack/manifest.mjs`
  （`PROFILE_BUNDLE_FILES`）复制同一清单，三处不一致时以 launcher 为准修齐。
  托盘的受管清单与中文标签在 `packaging/win-launcher/config.go` 维护。
- **产物检查**：launcher 启动前 `checkManagedPluginBundles` 校验每个受管包的
  patch 层与宿主/浏览器产物；绿色包检查扩展到全部 Bundle 文件（含 concise presets；
  顺带补上了此前遗漏的 browser-compat `dist/client.js`）。
- **第四批拆分**：`@dsh-remote/dsh-plugin-remote-settings` 承接 ownsHost 首页注入
  （Cordis 插件名保留 `dsh-remote-remote-privileged`，插件树身份不变）；
  remote-privileged 原包只剩 `dsh-overlay.yml`（connection 的 webServer 注入），
  无代码产物。`yolo-mode-check.mjs` 已改为验证 Bundle 装载路径（隔离 profile 带
  全部受管 Bundle + 壳级 overlay + probe）。
- **开发工作区**：全部插件进入根 package.json devDependencies，dsh 的 Bundle 双锚
  解析（安装锚点优先）在源码 checkout 里同样成立；`pnpm dev` 与 launcher 用同一
  受管清单确保 profile。
- **旧 profile 升级路径**：launcher/dev-stack 下次启动把 21 个新受管 Bundle 一次
  补插到 `dsh-web-app` 之后并记录状态文件；已存在的简洁模式行保持原位（层序与
  它无关）。全新 profile 直接得到完整默认模板。

已验证（自动检查）：全仓 lint / typecheck / build / test 通过；15 个可独立运行的
check 冒烟（yolo、concise、proxy、copilot-auth、models 系、files、services、terminal、
notify、agents-md、exec-process、turn-retry、chat-scroll、user-message-fork、
tools/skills-inspector）在 Bundle 装载形态下全部通过；开发栈完整启动（dsh 全部
Bundle 层装载、relay、connector、token 上报）。models-catalog 与
model-capabilities 无独立 check 脚本，靠包测试与实机验收；m0-fence 需要运行中的栈。

## 待实机验收（不因自动检查完成而勾选 roadmap）

- dsh 插件页逐个停用（每批抽代表）：dsh 正常启动、对应功能消失；launcher 下次
  启动不补回，控制台打印跳过提示。
- 托盘右键列出全部缺失受管项（不再是单项「补回简洁模式」），点击后写回并重启
  生效；`--restore-bundle` 等价可用。
- 影子型插件在 Bundle 层序下 priority 影子仍生效：user-message-fork 的 user
  renderer、files 的原生 files body。
- 带浏览器半的插件实机确认 combo 产物与槽位注册（页面 `__DSH_BOOT__` 与功能入口）。
- 涉 UI 的插件在深浅主题、中英文文案下验收。
- yolo-mode 停用重启后恢复原生权限审批、补回后回到固定 YOLO（安全方向见
  [04-security](04-security.md)）。

层序变化的既定边界（实施时已接受，README 已说明）：

- Bundle 层位于用户 profile patch 之下，用户手改 patch 可以覆盖或停用我们的插件行；
  托盘补回只读 `dsh.profile.bundles`，感知不到 profile patch 层的停用——
  「想让停用被托盘感知，请用 dsh 插件页的开关」。
- 插件间顺序从 `--patch` argv 顺序变为 bundles 数组顺序；受管插入统一排在
  `dsh-web-app` 之后，yolo 排在受管插入的末位（其配置覆盖最后应用）。

## 默认受管插件与停用后果

| 受管 Bundle（默认全开） | 停用后果（已逐个核实） |
|---|---|
| 简洁模式（concise-mode） | 丢失 concise / concise-ptc 预设，其余无影响 |
| 远程设置（remote-settings，自 remote-privileged 拆出的 ownsHost 部分） | 经 relay 地址访问时设置页回到 dsh 受限形态——**包括本机** 127.0.0.1:30809（relay 转发的 Host 不是 dsh 自己的 authority）；直连 dsh 端口的原生访问不受影响 |
| browser-compat（浏览器兼容） | 现代浏览器无感；旧 WebKit（旧 Safari / 手机 WebView）可能白屏，设置里的「浏览器日志」页消失 |
| directory-picker-browse（网页目录选择） | dsh 回到原生目录选择：本机用户桌面弹对话框（人在机器前可用）；远程浏览器看不到对话框、无法新建工作区（已有会话不受影响） |
| yolo-mode（固定 YOLO） | 恢复 dsh 原生权限审批（工具调用逐个批准）；补回即回到固定 YOLO。安全方向成立：停用是降权，启用是提权但必须主动走托盘/CLI，不会误触 |
| 其余 17 个通用插件 | 各自界面/功能入口消失，详见各包 README「停用与补回」；proxy 停用回退环境变量代理，terminal 停用影响 Linux sudo 管理入口，services 停用不停止已启动的服务进程 |

壳内唯一强制保留的是 connection 的 webServer 注入（remote-privileged 包的 overlay
片段），随 launcher 常驻传入；全部受管 Bundle 都停用时壳照常工作——dsh-base /
dsh-web-app 受上游保护不可卸，relay / connector / 托盘照常，loopback 访问照常。

## 暂缓：npm 发布（以后再考虑，路径为本仓库直接发布）

**发布不需要拆仓**：本仓库已是 pnpm workspace，每个插件包都是完整的 npm 包形态，
`pnpm --filter <包名> publish` 即可发布（`workspace:` 协议发布时自动替换为真实版本）。
拆仓只提供组织性收益（插件贡献者独立入口），不再是发布的先决条件；单仓发布保留
一次 dsh 升级 = 一个仓库修兼容 + 发新版 + 跑全套 check 的流程，check 脚本零复制。
前置条件是仓库内 Bundle 化完成（**已达成**，Bundle manifest 即可安装形态）。启动前准备：

- 22 个插件包现为 `private: true`；发布集去掉该标记，天然区分「发布集 / 壳私有集」。
- 9 个插件依赖 `@dsh-remote/plugin-ui`（`workspace:0.0.1`）：plugin-ui / plugin-build
  先或同时发布；核实它是打进 `dist/client.js` 的构建期依赖还是运行时导入。
- 建 `@dsh-remote` npm scope（org，公开包免费）。
- 版本纪律：semver + 每包 changelog + 发布脚本/CI（`pnpm -r publish` 或 changesets）；
  发布即公共承诺，破坏性变更须显式升主版本。
- `@deepseek-ai/*` 依赖写法决策：保持钉版 dependencies（用户安装时拉取匹配版本）
  或改 peerDependencies（依赖宿主解析，dsh 自己的插件族用这种模式）。
- 壳改为钉版引用（仍是本仓库 workspace 引用，无需改动），绿色包离线解压即用不变；
  其他用户经官方插件管理器安装。
- **主要顾虑**：发布后的维护承诺与 dsh 0.1.x 的破坏频率（0.1.6-alpha.2 一次断了
  5 处契约）；启动前重估维护精力。

## 暂缓：独立仓库（纯组织性选项，可永不实施）

只有当插件生态需要独立贡献入口或发布节奏时才值得评估；其代价是双仓升级协同
（插件仓先修兼容发版，壳仓再升 dsh 钉版）。若日后拆仓，承接范围与清单见此前的
设计：18 个通用插件 + plugin-ui/plugin-build + 对应 check 脚本与测试 harness 迁出，
壳仓保留 relay / connector / launcher / 托盘、五个默认受管插件与壳级 connection 注入。

## 暂缓：壳配置化引用（随发布一并考虑）

`dsh-remote.config.json` 增加 `plugins` 段（受管 Bundle 清单），launcher 据此装配
profile；记忆清单与停用/补回语义不变；connection webServer 注入**不走配置**、由
launcher 强制传入。默认配置等于五个默认受管 + 全部通用插件，老用户无感。
配置 schema 变更实施前在决策表补记。
