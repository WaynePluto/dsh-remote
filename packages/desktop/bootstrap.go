package main

import (
	"fmt"
	"net"
	"net/http"
	"net/url"
	"time"
)

// 只用 Wails AssetServer 完成一次顶层 HTTP 跳转，dsh 业务不经过它。
// 开发栈可能晚于壳启动：初始导航在这里被持有到 relay 端口开始监听再 302
// （与 statusHandler 同一条边界：页面自己发起的跳转进不了 relay，入口只能
// 由初始导航放行）；机器上线前的等待由 relay 自己的重试页承担。
func bootstrapHandler(target string) http.Handler {
	return bootstrapHandlerWithHold(target, bootstrapHoldSeconds*time.Second)
}

func bootstrapHandlerWithHold(target string, hold time.Duration) http.Handler {
	relayHost := ""
	if parsed, err := url.Parse(target); err == nil {
		relayHost = parsed.Host
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		deadline := time.Now().Add(hold)
		for relayHost != "" && !tcpReachable(relayHost) {
			if time.Now().After(deadline) {
				body := renderStatusPage(backendStatus{
					Phase:  phaseOffline,
					Detail: "开发栈的 relay 未在等待上限内监听 " + relayHost + "。",
				}, "请查看运行 pnpm dev 的终端输出或 dev-stack.log；栈正常后重新运行 pnpm dev:desktop。")
				w.Header().Set("Cache-Control", "no-store")
				w.Header().Set("Content-Type", "text/html; charset=utf-8")
				w.Header().Set("Content-Length", fmt.Sprint(len(body)))
				_, _ = w.Write(body)
				return
			}
			time.Sleep(200 * time.Millisecond)
		}
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Referrer-Policy", "no-referrer")
		http.Redirect(w, r, target, http.StatusFound)
	})
}

// tcpReachable 探测地址是否已有监听者；任何失败都按不可达处理。
func tcpReachable(hostPort string) bool {
	connection, err := net.DialTimeout("tcp", hostPort, 300*time.Millisecond)
	if err != nil {
		return false
	}
	_ = connection.Close()
	return true
}
