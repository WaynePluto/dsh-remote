package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
)

const (
	// 与 packages/launcher/src/config.ts 一样读取：默认从
	// 软件包根目录读取，除非 --config 指向其他位置。
	configFileName = "dsh-remote.config.json"

	// 默认值复制自 packages/launcher/src/config.ts。刚解压的
	// 软件包可能完全没有配置文件，而两个打开
	// 浏览器的菜单项仍必须指向正确的端口。
	defaultRelayPort  = 30809
	defaultDshProfile = "dsh-remote-web"
	homeDirName       = ".dsh-remote"

	// 两个 URL 都只使用 loopback：控制台也能从局域网访问，
	// 但菜单运行在本机；按铁律 11，127.0.0.1 是唯一
	// 不需要登录的访问入口。
	loopbackHost = "127.0.0.1"
)

// managedBundle 是一个受管 Profile Bundle 的包名与菜单文案。
type managedBundle struct {
	name  string
	label string
}

// managedBundles 与 packages/launcher/src/dsh-plugins.ts 的
// MANAGED_PLUGIN_PACKAGES 保持一致（launcher 是权威清单）；菜单据此列出
// 已被用户在 dsh 插件页停用、可补回的受管项。
var managedBundles = []managedBundle{
	{"@dsh-remote/dsh-plugin-remote-settings", "远程设置"},
	{"@dsh-remote/dsh-plugin-browser-compat", "浏览器兼容"},
	{"@dsh-remote/dsh-plugin-directory-picker-browse", "网页目录选择"},
	{"@dsh-remote/dsh-plugin-proxy", "出网代理"},
	{"@dsh-remote/dsh-plugin-copilot-auth", "Copilot 登录"},
	{"@dsh-remote/dsh-plugin-models-catalog", "模型目录更新"},
	{"@dsh-remote/dsh-plugin-model-capabilities", "模型能力与协议"},
	{"@dsh-remote/dsh-plugin-favorite-models", "常用模型"},
	{"@dsh-remote/dsh-plugin-concise-mode", "简洁模式"},
	{"@dsh-remote/dsh-plugin-turn-retry", "失败重试"},
	{"@dsh-remote/dsh-plugin-exec-process", "执行过程"},
	{"@dsh-remote/dsh-plugin-chat-scroll", "会话滚动导航"},
	{"@dsh-remote/dsh-plugin-user-message-fork", "用户消息分叉"},
	{"@dsh-remote/dsh-plugin-agents-md", "全局提示词"},
	{"@dsh-remote/dsh-plugin-notify", "任务通知"},
	{"@dsh-remote/dsh-plugin-services", "常驻服务"},
	{"@dsh-remote/dsh-plugin-terminal", "交互终端"},
	{"@dsh-remote/dsh-plugin-tools-inspector", "工具状态"},
	{"@dsh-remote/dsh-plugin-skills-inspector", "技能状态"},
	{"@dsh-remote/dsh-plugin-files", "文件浏览"},
	{"@dsh-remote/dsh-plugin-subagent-depth", "子代理深度"},
	{"@dsh-remote/dsh-plugin-yolo-mode", "固定 YOLO"},
}

// settings 是 tray 需要的 launcher 配置子集：两个菜单
// URL 共用的 relay 端口，以及日志文件所在的 home 目录。
// dsh 自己的端口不在这里：菜单不直连 dsh，直连只
// 认 launcher 从 dsh 输出截获的 token 交换结果。
type settings struct {
	relayPort  int
	home       string
	dshProfile string
	// 已读取的配置文件；使用内置默认值时为空。
	path string
}

// rawConfig 刻意只描述这些字段。launcher 会校验
// 整个文档并拒绝任何不合规内容，因此
// 这里再实现一个更严格的读取器只会与它产生分歧。
type rawConfig struct {
	Relay *struct {
		Port *int `json:"port"`
	} `json:"relay"`
	Home *string `json:"home"`
	Dsh  *struct {
		Profile *string `json:"profile"`
	} `json:"dsh"`
}

// dshWebURL 打开的是 dsh 界面。relay 只把 /_admin、/auth、setup
// 等自有路径留给自己，其余请求（包括 /）全部隧道转发给 dsh，
// 并在 dsh 首页 401 时用它截获的 token 完成一次交换；直连 dsh
// 端口没有这次交换，只会看到 "dsh web authentication required"。
func (s settings) dshWebURL() string {
	return fmt.Sprintf("http://%s:%d", loopbackHost, s.relayPort)
}

// adminURL 是 relay 自己的管理控制台（设备、审计、远程入口）。
func (s settings) adminURL() string {
	return fmt.Sprintf("http://%s:%d/_admin", loopbackHost, s.relayPort)
}

func (s settings) logPath() string {
	return filepath.Join(s.home, logFileName)
}

// loadSettings 读取配置文件，失败时回退到文档规定的默认值。
//
// 文件缺失或损坏时这里不会报告：launcher 稍后会重新读取同一个
// 文件，并在日志中准确说明问题。
// 如果因此拒绝显示托盘图标，用户就没有办法读取
// 这条消息。
func loadSettings(root string, arguments []string) settings {
	resolved := settings{relayPort: defaultRelayPort, home: defaultHome(root), dshProfile: defaultDshProfile}
	path := configPath(root, arguments)
	data, err := os.ReadFile(path)
	if err != nil {
		return resolved
	}
	resolved.path = path
	var raw rawConfig
	if err := json.Unmarshal(data, &raw); err != nil {
		return resolved
	}
	if raw.Relay != nil && raw.Relay.Port != nil && validPort(*raw.Relay.Port) {
		resolved.relayPort = *raw.Relay.Port
	}
	if raw.Home != nil && *raw.Home != "" {
		resolved.home = expandHome(*raw.Home, root)
	}
	if raw.Dsh != nil && raw.Dsh.Profile != nil && *raw.Dsh.Profile != "" {
		resolved.dshProfile = *raw.Dsh.Profile
	}
	return resolved
}

func validPort(port int) bool {
	return port >= 1 && port <= 65535
}

// configPath 遵守传给 launcher 的 --config，因此日志和
// 两个 URL 描述的确实是当前运行的 stack。
func configPath(root string, arguments []string) string {
	for index, argument := range arguments {
		if value, found := strings.CutPrefix(argument, "--config="); found {
			return expandHome(value, root)
		}
		if argument == "--config" && index+1 < len(arguments) {
			return expandHome(arguments[index+1], root)
		}
	}
	return filepath.Join(root, configFileName)
}

func defaultHome(root string) string {
	home, err := os.UserHomeDir()
	if err != nil {
		// 即使没有 home 目录也仍要写日志；软件包
		// 根目录是本程序唯一能确定的目录。
		return filepath.Join(root, homeDirName)
	}
	return filepath.Join(home, homeDirName)
}

// expandHome 与 launcher 自己的路径处理一致：开头的 ~ 表示用户
// home；相对路径相对于软件包根目录，因为这就是
// 传给 launcher 子进程的工作目录。
func expandHome(path string, root string) string {
	if path == "~" {
		if home, err := os.UserHomeDir(); err == nil {
			return home
		}
		return root
	}
	if strings.HasPrefix(path, "~/") || strings.HasPrefix(path, `~\`) {
		if home, err := os.UserHomeDir(); err == nil {
			return filepath.Join(home, path[2:])
		}
	}
	if filepath.IsAbs(path) {
		return filepath.Clean(path)
	}
	return filepath.Join(root, path)
}

// dshHomeDir 与 packages/launcher/src/profile.ts 的 resolveDshHome 一致：
// $DSH_HOME（空白视为未设置）优先，否则 ~/.dsh。无法确定时返回空串，
// 调用方按「状态未知」处理（不显示补回菜单项）。
func dshHomeDir() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	configured := strings.TrimSpace(os.Getenv("DSH_HOME"))
	if configured == "" {
		return filepath.Join(home, ".dsh")
	}
	if configured == "~" {
		return home
	}
	if strings.HasPrefix(configured, "~/") || strings.HasPrefix(configured, `~\`) {
		return filepath.Join(home, configured[2:])
	}
	if !filepath.IsAbs(configured) {
		// resolveDshHome 会 resolve() 相对路径；托盘以工作目录不可预测为由
		// 不做此推断，按未知处理。
		return ""
	}
	return filepath.Clean(configured)
}

// missingManagedBundles 报告哪些受管 Bundle 已不在 dsh profile 的 bundles
// 列表里（用户在 dsh 插件页停用了它们）。任何读取或解析失败都返回空表：
// 状态未知时不显示「补回」菜单项，绝不凭猜测改写 profile。
func missingManagedBundles(dshHome string, profile string) []managedBundle {
	if dshHome == "" || profile == "" {
		return nil
	}
	data, err := os.ReadFile(filepath.Join(dshHome, "profiles", profile, "package.json"))
	if err != nil {
		return nil
	}
	var manifest struct {
		Dsh *struct {
			Profile *struct {
				Bundles []string `json:"bundles"`
			} `json:"profile"`
		} `json:"dsh"`
	}
	if err := json.Unmarshal(data, &manifest); err != nil {
		return nil
	}
	bundles := manifest.Dsh.Profile.Bundles
	if bundles == nil {
		return nil
	}
	var missing []managedBundle
	for _, candidate := range managedBundles {
		if !slices.Contains(bundles, candidate.name) {
			missing = append(missing, candidate)
		}
	}
	return missing
}
