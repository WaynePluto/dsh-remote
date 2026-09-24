package main

import (
	"context"
	"fmt"
	"log"
	"net/url"
	"os"
	"sync/atomic"
	"time"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// bindingOrigin 返回追加进 BindingsAllowedOrigins 的页面来源。
// 主页与管理页同源（同一 relay 端口），一个来源即可覆盖两者；
// 这只放行 Go 绑定调用，不是导航白名单。
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

func main() {
	config, err := parsePreviewOptions(os.Args[1:])
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	if config.selfCheck {
		fmt.Println("dsh-remote 桌面预览版参数有效；未启动窗口或后台")
		return
	}
	origin, err := bindingOrigin(config.relayURL)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	log.Println("警告：桌面预览版尚未隔离外站或 WebView2 权限，仅供开发；原有 relay/dsh 认证保持不变")
	var window atomic.Value
	currentWindow := func() context.Context {
		if value := window.Load(); value != nil {
			return value.(context.Context)
		}
		return nil
	}
	chrome := &Chrome{currentWindow: currentWindow, relayURL: config.relayURL, adminURL: config.adminURL}

	var stopTray atomic.Value
	if err := wails.Run(&options.App{
		Title: "dsh-remote",
		// 页面以 body zoom=(高-36)/高 完整布局进自绘条以下区域，视口高度不再被裁切。
		Width:                  1100,
		Height:                 750,
		HideWindowOnClose:      true,
		Frameless:              true,
		Bind:                   []interface{}{chrome},
		BindingsAllowedOrigins: origin,
		AssetServer:            &assetserver.Options{Handler: bootstrapHandler(config.relayURL)},
		OnStartup: func(ctx context.Context) {
			window.Store(ctx)
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
			stop, err := startWindowsTray(
				func() {
					runtime.WindowUnminimise(ctx)
					runtime.WindowShow(ctx)
				},
				func() { runtime.BrowserOpenURL(ctx, config.relayURL) },
				func() { runtime.BrowserOpenURL(ctx, config.adminURL) },
				func() { runtime.Quit(ctx) },
			)
			if err != nil {
				log.Printf("创建桌面托盘失败：%v", err)
				runtime.Quit(ctx)
				return
			}
			stopTray.Store(stop)
		},
		// 每次顶层导航（主页/管理互切、首次 302）后重建自绘标题栏并校正任务栏图标。
		OnDomReady: func(ctx context.Context) {
			setWindowsTaskbarIcon()
			injectChromeBar(ctx, config.relayURL, config.adminURL)
		},
		OnShutdown: func(_ context.Context) {
			if value := stopTray.Load(); value != nil {
				value.(func())()
			}
		},
	}); err != nil {
		log.Fatal(err)
	}
}
