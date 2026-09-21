# 插件可选化计划

**当前只做一件事：仓库内 Bundle 化**——把全部插件转成用户可停用的 Profile Bundle
（简洁模式已完成，是参照实现）。「npm 发布」「独立仓库」与「壳配置化引用」
**暂缓，以后再考虑**，相关设计保留在文末备查；发布路径已明确为**本仓库直接发布**，不需要拆仓。决策记录见 [01-decisions](01-decisions.md) D20。
分批实施、按批验收，未实机验收不勾选 roadmap。

## 已决事项（2026-09）

- **统一语义**：停用 = dsh 插件页把包名移出 `dsh.profile.bundles`；launcher 对受管
  Bundle 只确保一次（profile 内 `dsh-remote-bundles-state.json`），此后尊重停用；
  补回 = 托盘菜单或 `--restore-bundle`。
- **不做真卸载**：可卸载要求插件是 profile 的 pnpm 依赖，代价是版本漂移
  （profile 内拷贝冻结在安装时刻）、运行时依赖 pnpm（绿色包机器未必有）、
  补回从改数组变成跑包管理器。停用已等价于卸载（界面彻底消失），文件常驻
  换来随 dsh-remote 升级、离线补回、零版本漂移。
- **默认受管替代承重墙**：远程使能插件不再「强制注入、不可停」。
  remote-privileged 拆成壳级 connection webServer 注入（**不可停**——它是全部插件
  RPC 通道的地基，与远程无关，本机使用同样需要）+ 可停用的 ownsHost 声明；
  连同 browser-compat、directory-picker-browse、yolo-mode 共 4 个转为**默认受管
  Bundle**：默认全开、开箱即完整远程体验，用户知情后可停用，托盘/CLI 补回。
  由此支持「纯本机 dsh 套壳 + 托盘」的使用方式；「默认固定 YOLO」的产品决策
  不变，只是从不可关变为默认开、可关。
- **npm 发布暂缓（路径为本仓库直接发布）**：18 个通用插件只依赖 dsh 插件契约、
  对任何 dsh 用户都有价值，上游 0.1.6 的插件管理器与宿主兼容性 manifest 也为
  第三方发布留好了生态位。本仓库已是 pnpm workspace，各包可直接发布，
  无需拆仓（拆仓只提供组织性收益）；发布动作等 Bundle 化完成与版本纪律就绪后
  再启动（见文末）。

## 默认受管插件与停用后果

| 受管 Bundle（默认全开） | 停用后果（已逐个核实） |
|---|---|
| 简洁模式（concise-mode） | 丢失 concise / concise-ptc 预设，其余无影响 |
| 远程设置（remote-privileged 拆出的 ownsHost 部分） | 经 relay 地址访问时设置页回到 dsh 受限形态——**包括本机** 127.0.0.1:30809（relay 转发的 Host 不是 dsh 自己的 authority）；直连 dsh 端口的原生访问不受影响 |
| browser-compat（浏览器兼容） | 现代浏览器无感；旧 WebKit（旧 Safari / 手机 WebView）可能白屏 |
| directory-picker-browse（网页目录选择） | dsh 回到原生目录选择：本机用户桌面弹对话框（人在机器前可用）；远程浏览器看不到对话框、无法新建工作区（已有会话不受影响） |
| yolo-mode（固定 YOLO） | 恢复 dsh 原生权限审批（工具调用逐个批准）；补回即回到固定 YOLO。安全方向成立：停用是降权，启用是提权但必须主动走托盘/CLI，不会误触 |

壳内唯一强制保留的是 connection 的 webServer 注入（一个 overlay 片段），随 launcher
常驻传入；全部受管 Bundle 都停用时壳照常工作——dsh-base / dsh-web-app 受上游保护
不可卸，relay / connector / 托盘照常，loopback 访问照常。

## 当前阶段：仓库内 Bundle 化

把插件从 launcher `--patch` overlay 转成 Profile Bundle，使用与简洁模式相同的
记忆清单与托盘补回机制。分四批，**第四批耦合最高，须在前三批机制稳定后进行**：

| 批次 | 插件 | 特点 |
|---|---|---|
| 一 | chat-scroll、notify、favorite-models、subagent-depth、tools-inspector、skills-inspector、user-message-fork | 纯 UI 增强，无宿主配置耦合 |
| 二 | agents-md、proxy、copilot-auth、models-catalog、model-capabilities | 设置页类；proxy 停用后回退环境变量代理，README 须说明 |
| 三 | exec-process、turn-retry、files、services、terminal | 会话核心；terminal 停用影响 Linux sudo 管理入口，README 须说明 |
| 四 | ownsHost 声明（自 remote-privileged 拆出）、browser-compat、directory-picker-browse、yolo-mode | 停用后果见表上方；yolo 同步修订 [安全说明](04-security.md)；拆分后 remote-privileged 原包只剩壳级注入职责 |

每个插件的转换步骤：

1. package.json 声明 `dsh.bundle.patch` 指向本包 overlay（对照简洁模式的
   `cordis.patch.yml` 确认 Bundle 装载读取的文件名与入口写法）。
2. `packages/launcher/src/dsh-plugins.ts` 的 overlay 清单移除该插件；
   `packages/launcher/src/index.ts` 的受管 Bundle 清单（`managedBundles`）加入它。
3. 同步 `scripts/local-config.mjs`（dev-stack 的 overlay 扫描）与 `scripts/pack.mjs`
   的产物检查——三处清单不一致时以 launcher 为准修齐。
4. 插件 README 增加「停用与补回」一节（含后果说明）；`docs/plugins.md` 索引行补注可停用。
5. 跑该插件的 check 脚本与全仓 `pnpm lint / typecheck / build / test`。

第四批额外步骤：先把 remote-privileged overlay 里的
`- id: connection / inject: [webRuntime, webServer]` 片段迁入壳级常驻 overlay
（随 launcher 传入，位置由 `dsh-plugins.ts` 固定在首位），再将其余部分
（ownsHost 声明 + 首页注入）独立成受管 Bundle；`yolo-mode-check.mjs` 随之改为
验证 Bundle 装载路径。

风险与边界：

- **层序变化**：Bundle 层位于用户 profile patch（`cordis.patch.yml`）之下，用户手改
  patch 从此能覆盖或停用我们的插件行（现在是 overlay 层保护）。托盘补回只读
  `dsh.profile.bundles`，感知不到 profile patch 层的停用——README 说明
  「想让停用被托盘感知，请用 dsh 插件页的开关」。
- **影子型插件**（user-message-fork 影子 user renderer、files shadow 原生 files body）
  需实机确认 Bundle 层序下 priority 影子仍生效。
- **插件间顺序**从 `--patch` argv 顺序变为 bundles 数组顺序；受管插入统一排在
  `dsh-web-app` 之后（`insertManagedBundles` 现有行为）。yolo 的配置覆盖必须在
  其他受管 Bundle 之后生效——排在受管插入的末位。
- **浏览器半**经 Bundle 模块表装载（简洁模式已验证可行）；每个带 client 半的插件
  都要实机验证 combo 产物与槽位注册。
- **托盘菜单演进**：受管项超过一个后，Go 侧从「单项菜单」改为列出 bundles 数组中
  缺失的全部受管项（受管清单随壳下发或指向 `packages/launcher/src/profile.ts` 维护）。

每批验收标准：

- 在 dsh 插件页停用后：dsh 正常启动、对应功能消失；launcher 下次启动不补回，
  控制台打印跳过提示。
- 托盘出现「补回 xxx」，点击后写回并重启生效；`--restore-bundle` 等价可用。
- 涉 UI 的插件在深浅主题、中英文文案下验收。
- 该批全部 check 脚本与全仓四件套（lint / typecheck / build / test）通过。

## 暂缓：npm 发布（以后再考虑，路径为本仓库直接发布）

**发布不需要拆仓**：本仓库已是 pnpm workspace，每个插件包都是完整的 npm 包形态，
`pnpm --filter <包名> publish` 即可发布（`workspace:` 协议发布时自动替换为真实版本）。
拆仓只提供组织性收益（插件贡献者独立入口），不再是发布的先决条件；单仓发布保留
一次 dsh 升级 = 一个仓库修兼容 + 发新版 + 跑全套 check 的流程，check 脚本零复制。
前置条件是仓库内 Bundle 化完成（Bundle manifest 即可安装形态）。启动前准备：

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
