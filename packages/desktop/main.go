package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"sync/atomic"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/menu"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

func navigateWindow(ctx context.Context, target string) {
	literal, err := json.Marshal(target)
	if err != nil {
		log.Printf("生成桌面导航地址失败：%v", err)
		return
	}
	runtime.WindowExecJS(ctx, "location.assign("+string(literal)+")")
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
	log.Println("警告：桌面预览版尚未隔离外站或 WebView2 权限，仅供开发；原有 relay/dsh 认证保持不变")
	var window atomic.Value
	currentWindow := func() context.Context {
		if value := window.Load(); value != nil {
			return value.(context.Context)
		}
		return nil
	}
	applicationMenu := menu.NewMenu()
	pageMenu := applicationMenu.AddSubmenu("页面")
	pageMenu.AddText("主页", nil, func(_ *menu.CallbackData) {
		if ctx := currentWindow(); ctx != nil {
			navigateWindow(ctx, config.relayURL)
		}
	})
	pageMenu.AddText("管理", nil, func(_ *menu.CallbackData) {
		if ctx := currentWindow(); ctx != nil {
			navigateWindow(ctx, config.adminURL)
		}
	})
	externalMenu := applicationMenu.AddSubmenu("外部")
	externalMenu.AddText("主页", nil, func(_ *menu.CallbackData) {
		if ctx := currentWindow(); ctx != nil {
			runtime.BrowserOpenURL(ctx, config.relayURL)
		}
	})
	externalMenu.AddText("管理", nil, func(_ *menu.CallbackData) {
		if ctx := currentWindow(); ctx != nil {
			runtime.BrowserOpenURL(ctx, config.adminURL)
		}
	})
	appMenu := applicationMenu.AddSubmenu("应用")
	appMenu.AddText("隐藏", nil, func(_ *menu.CallbackData) {
		if ctx := currentWindow(); ctx != nil {
			runtime.WindowHide(ctx)
		}
	})
	appMenu.AddText("退出", nil, func(_ *menu.CallbackData) {
		if ctx := currentWindow(); ctx != nil {
			runtime.Quit(ctx)
		}
	})

	var stopTray atomic.Value
	if err := wails.Run(&options.App{
		Title:                  "dsh-remote",
		Width:                  1100,
		Height:                 750,
		HideWindowOnClose:      true,
		Menu:                   applicationMenu,
		Bind:                   nil,
		BindingsAllowedOrigins: "",
		AssetServer:            &assetserver.Options{Handler: bootstrapHandler(config.relayURL)},
		OnStartup: func(ctx context.Context) {
			window.Store(ctx)
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
		OnShutdown: func(_ context.Context) {
			if value := stopTray.Load(); value != nil {
				value.(func())()
			}
		},
	}); err != nil {
		log.Fatal(err)
	}
}
