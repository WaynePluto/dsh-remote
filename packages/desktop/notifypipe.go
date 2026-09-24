package main

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"log"
	"net"
	"strings"
	"time"

	"git.sr.ht/~jackmordaunt/go-toast/v2"
	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// notifyAddr 是桌面壳接收 notify 插件事件的仅本机回环地址（S2 冻结契约）。
const notifyAddr = "127.0.0.1:30810"

// notifyAuthTimeout 是客户端必须在连接后完成令牌握手的时限。
const notifyAuthTimeout = 3 * time.Second

type notifyEvent struct {
	SessionID string `json:"sessionId"`
	Title     string `json:"title"`
	Body      string `json:"body"`
}

// newNotifyToken 生成一次性的管道共享令牌；桌面壳 → launcher → dsh → notify
// 插件经环境变量逐级传递。没有令牌的客户端（包括本机其他进程）在握手前
// 无法投递事件，防止任意本地进程伪造桌面通知。
func newNotifyToken() string {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		log.Printf("生成通知管道令牌失败，桌面通知点击定位将不可用：%v", err)
		return ""
	}
	return hex.EncodeToString(raw)
}

// startNotifyPipe 监听 notify 插件的事件连接，把事件转成系统 toast；
// 用户点击 toast 时恢复窗口并在页面内定位会话。令牌为空时不监听
// （attach 开发模式没有令牌，插件回落既有 Windows toast）。
func startNotifyPipe(token string, onEvent func(notifyEvent)) {
	if token == "" {
		return
	}
	listener, err := net.Listen("tcp", notifyAddr)
	if err != nil {
		log.Printf("通知管道监听失败（端口可能被占用）：%v", err)
		return
	}
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				log.Printf("通知管道退出：%v", err)
				return
			}
			go serveNotifyConnection(conn, token, onEvent)
		}
	}()
}

// serveNotifyConnection 校验首行令牌后才接受事件；错误立即断开。
func serveNotifyConnection(conn net.Conn, token string, onEvent func(notifyEvent)) {
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(notifyAuthTimeout))
	scanner := bufio.NewScanner(conn)
	if !scanner.Scan() {
		return
	}
	var handshake struct {
		Auth string `json:"auth"`
	}
	if err := json.Unmarshal(scanner.Bytes(), &handshake); err != nil || handshake.Auth != token {
		log.Printf("通知管道拒绝了未通过鉴权的连接")
		return
	}
	_ = conn.SetDeadline(time.Time{})
	for scanner.Scan() {
		var event notifyEvent
		if err := json.Unmarshal(scanner.Bytes(), &event); err != nil {
			continue
		}
		onEvent(event)
	}
}

// showNotifyToast 弹出可点击的系统通知；点击后壳内定位会话。
func showNotifyToast(event notifyEvent) {
	notification := toast.Notification{
		AppID:               "dsh-station",
		Title:               event.Title,
		Body:                event.Body,
		ActivationType:      toast.Foreground,
		ActivationArguments: "open-session=" + event.SessionID,
	}
	if err := notification.Push(); err != nil {
		log.Printf("桌面通知推送失败：%v", err)
	}
}

// installNotifyActivation 注册 toast 点击回调：恢复窗口并派发会话定位事件，
// 由 notify 插件 client 半监听并调用 dsh 原生 uiWorkspace.openSession。
func installNotifyActivation(currentWindow func() context.Context) {
	toast.SetActivationCallback(func(args string, _ []toast.UserData) {
		sessionID := strings.TrimPrefix(args, "open-session=")
		if sessionID == "" {
			return
		}
		ctx := currentWindow()
		if ctx == nil {
			return
		}
		runtime.WindowUnminimise(ctx)
		runtime.WindowShow(ctx)
		// 已显示的窗口 WindowShow 不会抢前台，点击通知必须置前。
		desktopTrayFoundWindow = 0
		desktopTrayEnumWindows.Call(desktopTrayEnumProc, 0)
		if hwnd := desktopTrayFoundWindow; hwnd != 0 {
			desktopTraySetForegroundWindow.Call(hwnd)
		}
		log.Printf("通知点击激活：args=%q", args)
		runtime.WindowExecJS(ctx,
			"window.dispatchEvent(new CustomEvent('dsh-station:open-session',{detail:"+jsonString(sessionID)+"}))")
	})
}

func jsonString(value string) string {
	encoded, err := json.Marshal(value)
	if err != nil {
		return "''"
	}
	return string(encoded)
}
