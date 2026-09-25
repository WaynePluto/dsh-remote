package main

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"os"
	"sync/atomic"
	"time"

	goruntime "runtime"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// bindingOrigin 返回追加进 BindingsAllowedOrigins 的页面来源。
// 这只放行 Go 绑定调用（自绘条的外部打开等），不是导航白名单。
// attach 模式用实际的开发栈地址；独立模式的 relay 端口由后台运行后
// 才上报，这里固定追加默认端口来源——用户改过 relay 端口时自绘条的
// 「在浏览器中打开」按钮会静默失效（托盘菜单入口不受影响），
// 换来的是 Go 不复制 launcher 的配置解析（计划 §5.1）。
func bindingOrigin(relayURL string) (string, error) {
	parsed, err := url.Parse(relayURL)
	if err != nil {
		return "", err
	}
	if parsed.Scheme != "http" || parsed.Hostname() != "127.0.0.1" {
		return "", fmt.Errorf("绑定来源必须是大机 loopback relay：%q", relayURL)
	}
	return parsed.Scheme + "://" + parsed.Host, nil
}

// assetServerOrigin 是 Wails 内置资产服务器在本机页面的来源。
// 状态页驻留在这里；后台停止/失败时把窗口从 relay 页面导航回这里。
// Windows/Linux 用 http://wails.localhost/，macOS 的 wails:// 形式留待 S10 实测。
func assetServerOrigin() string {
	if goruntime.GOOS == "darwin" {
		return "wails://wails/"
	}
	return "http://wails.localhost/"
}

// assetHandler 选择内置资产服务器的行为：attach 模式维持一次 302 引导，
// 独立模式常驻状态页（就绪后对根路径 302 进真实 relay origin）。
func assetHandler(manager *backendManager, attachRelayURL string) http.Handler {
	if manager != nil {
		return statusHandler(manager)
	}
	return bootstrapHandler(attachRelayURL)
}

func trayTipText(status backendStatus) string {
	if status.HasURLs {
		return fmt.Sprintf("DSH 工作站 · %s · %s", phaseLabel(status.displayPhase()), status.URLs.Local)
	}
	return "DSH 工作站 · " + phaseLabel(status.displayPhase())
}

func managerStatus(manager *backendManager) backendStatus {
	if manager == nil {
		return backendStatus{}
	}
	return manager.Status()
}

var (
	// respawning 标记「壳自重启」路径：退出钩子不得再停后台（新壳接管启动）。
	respawning atomic.Bool
	// singleInstanceRelease 由 standalone 模式的启动路径赋值；自重启前释放。
	singleInstanceRelease func()
)

// shellRestart 是托盘「启动后台 / 重启后台」的统一实现：干净停止现有后台，
// 释放单实例互斥体后重新拉起自己；新壳走正常启动路径（初始导航持有 → 302
// 进 relay）。webview 的初始导航一生只有一次，页面发起的跳转进不了 relay，
// 因此恢复/重启只能换一个新壳。
func shellRestart(manager *backendManager) {
	if manager != nil {
		manager.StopAndWait()
	}
	if singleInstanceRelease != nil {
		singleInstanceRelease()
		singleInstanceRelease = nil
	}
	executable, err := os.Executable()
	if err != nil {
		log.Printf("自重启失败（找不到自身路径）：%v", err)
		return
	}
	if err := spawnShellReplacement(executable); err != nil {
		log.Printf("自重启失败：%v", err)
		return
	}
	respawning.Store(true)
}

func main() {
	config, err := parseRunOptions(os.Args[1:])
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	if config.selfCheck {
		if config.mode == modeAttach {
			fmt.Println("dsh-station 桌面（attach 开发模式）参数有效；未启动窗口或后台")
			return
		}
		payload, discoveryErr := discoverPayload(config.appDir)
		if discoveryErr != nil {
			fmt.Fprintf(os.Stderr, "自检失败：%v\n", discoveryErr)
			os.Exit(1)
		}
		fmt.Printf("dsh-station 桌面自检通过：载荷 %s；Node %s（随包=%v）\n",
			payload.packageDir, payload.nodePath, payload.bundledNode)
		return
	}

	var window atomic.Value
	currentWindow := func() context.Context {
		if value := window.Load(); value != nil {
			return value.(context.Context)
		}
		return nil
	}
	var stopTray atomic.Value

	var (
		manager     *backendManager
		relayURL    string
		adminURL    string
		bindingsURL string
		notifyToken string
	)
	// 开发壳用标题后缀与发行版实例区分：同名窗口会让托盘/任务栏激活
	// 与单实例 FindWindow 定位混淆。
	windowTitle := "DSH 工作站"
	barTitleSuffix := ""
	if config.mode == modeAttach {
		windowTitle = "DSH 工作站 (dev)"
		barTitleSuffix = " (dev)"
		relayURL = config.relayURL
		adminURL = config.adminURL
		bindingsURL = relayURL
	} else {
		// 独立模式：默认入口按 launcher 的默认 relay 端口声明（见 bindingOrigin）。
		relayURL = "http://127.0.0.1:30809/"
		adminURL = "http://127.0.0.1:30809/_admin"
		bindingsURL = relayURL
		payload, discoveryErr := discoverPayload(config.appDir)
		notifyToken = newNotifyToken()
		manager = newBackendManager(payload, notifyToken, nil)
		if discoveryErr != nil {
			manager.setStatus(backendStatus{Phase: phaseFailed, Detail: discoveryErr.Error()})
			log.Printf("载荷发现失败：%v", discoveryErr)
		}
	}
	chrome := &Chrome{currentWindow: currentWindow, resolve: func() (string, string) {
		if manager != nil {
			if status := manager.Status(); status.HasURLs {
				return status.URLs.Local, status.URLs.Admin
			}
		}
		return relayURL, adminURL
	}}

	origin, err := bindingOrigin(bindingsURL)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}

	if config.mode == modeStandalone {
		ok, release := acquireSingleInstance()
		if !ok {
			// 重复启动：已唤起既有窗口，直接退出，绝不跑第二套壳+后台。
			return
		}
		defer release()
		singleInstanceRelease = release
	}

	// 阶段状态变化：更新托盘提示；就绪/失败时确保窗口可见。
	// 进入 relay 只能靠 webview 初始导航经 AssetServer 302（statusHandler
	// 持有它直到就绪）；页面发起的任何跳转都会被 relay 按 cross-site 拒绝。
	lastPhase := phaseOffline
	if manager != nil {
		manager.onChange = func(status backendStatus) {
			if status.Phase != lastPhase {
				if status.Phase == phaseReady || status.Phase == phaseFailed || status.Phase == phaseOffline {
					if ctx := currentWindow(); ctx != nil {
						runtime.WindowShow(ctx)
					}
				}
				lastPhase = status.Phase
			}
			if value := stopTray.Load(); value != nil {
				value.(*desktopTrayHandle).SetTip(trayTipText(status))
			}
		}
	}

	if err := wails.Run(&options.App{
		Title: windowTitle,
		// 默认窗口取黄金比例（1618:1000≈1.618），在 1080p 下留出任务栏与边距；
		// 页面以 body zoom=(高-36)/高 完整布局进自绘条以下区域。
		Width:                  1360,
		Height:                 962,
		MinWidth:               960,
		MinHeight:              880,
		HideWindowOnClose:      true,
		Frameless:              true,
		Bind:                   []interface{}{chrome},
		BindingsAllowedOrigins: origin,
		AssetServer:            &assetserver.Options{Handler: assetHandler(manager, relayURL)},
		OnStartup: func(ctx context.Context) {
			window.Store(ctx)
			installNotifyActivation(currentWindow)
			if config.mode == modeStandalone {
				startNotifyPipe(notifyToken, func(event notifyEvent) {
					showNotifyToast(event)
				})
			}
			// 窗口显示晚于首次 OnDomReady，图标设置改为后台重试直到枚举到窗口，
			// 否则任务栏按钮、hover 预览和 Alt+Tab 会一直显示系统默认图标。
			go func() {
				for i := 0; i < 60; i++ {
					if setWindowsTaskbarIcon() {
						return
					}
					time.Sleep(500 * time.Millisecond)
				}
				log.Println("警告：未能设置任务栏图标（60 次重试失败）")
			}()
			trayHandle, trayErr := startWindowsTray(desktopTrayCallbacks{
				onShow: func() {
					runtime.WindowUnminimise(ctx)
					runtime.WindowShow(ctx)
				},
				onBrowser: func() {
					home, _ := chrome.resolve()
					runtime.BrowserOpenURL(ctx, home)
				},
				onAdmin: func() {
					_, admin := chrome.resolve()
					runtime.BrowserOpenURL(ctx, admin)
				},
				onStart: func() {
					if manager == nil {
						return
					}
					shellRestart(manager)
					runtime.Quit(ctx)
				},
				onStop: func() {
					if manager == nil {
						return
					}
					if err := manager.Stop(); err != nil {
						log.Printf("停止后台失败：%v", err)
					}
				},
				onRestart: func() {
					if manager == nil {
						return
					}
					shellRestart(manager)
					runtime.Quit(ctx)
				},
				onQuit: func() {
					if manager != nil && !respawning.Load() {
						manager.StopAndWait()
					}
					runtime.Quit(ctx)
				},
			})
			if trayErr != nil {
				log.Printf("创建桌面托盘失败：%v", trayErr)
				return
			}
			stopTray.Store(trayHandle)
			trayHandle.SetTip(trayTipText(managerStatus(manager)))
			if manager != nil {
				// 独立模式双击即用：窗口初始就是状态页，就绪后自动 302 进 relay。
				if err := manager.Start(); err != nil {
					log.Printf("启动后台失败：%v", err)
					manager.setStatus(backendStatus{Phase: phaseFailed, Detail: err.Error()})
				}
			}
		},
		// 每次顶层导航（主页/管理互切、状态页 302、引导 302）后重建自绘标题栏并校正任务栏图标。
		OnDomReady: func(ctx context.Context) {
			setWindowsTaskbarIcon()
			home, admin := chrome.resolve()
			injectChromeBar(ctx, home, admin, barTitleSuffix)
		},
		OnShutdown: func(_ context.Context) {
			if value := stopTray.Load(); value != nil {
				value.(*desktopTrayHandle).Stop()
			}
			if manager != nil && !respawning.Load() {
				manager.StopAndWait()
			}
		},
	}); err != nil {
		log.Fatal(err)
	}
}
