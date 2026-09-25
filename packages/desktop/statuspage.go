package main

import (
	"fmt"
	"html"
	"net/http"
	"strings"
	"time"
)

// bootstrapHoldSeconds 是初始导航在后台启动期间被持有的上限；
// 超过它（或后台失败）则回答状态页。上限必须低于浏览器引擎的
// 响应头超时（约 300s），并覆盖首次运行插件同步的耗时。
const bootstrapHoldSeconds = 150

// statusHandler 是独立模式下 AssetServer 的唯一处理器。
// webview 的初始导航是唯一能进入 relay 的入口：任何由页面发起的后续
// 跳转（meta-refresh、JS location）都会带 Sec-Fetch-Site: cross-site，
// 被 relay 的原始安全检查正确拒绝。因此这里「持有」初始请求直到后台
// 就绪再发一次 302（与 attach 模式的引导跳转同一条安全边界）；失败或
// 超时才回答状态页，恢复走托盘「启动后台」（壳会自重启取得新的初始导航）。
func statusHandler(manager *backendManager) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			http.NotFound(w, r)
			return
		}
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		deadline := time.Now().Add(bootstrapHoldSeconds * time.Second)
		status := manager.Status()
		for status.Phase != phaseReady {
			if status.Phase == phaseFailed || status.Phase == phaseOffline {
				break
			}
			if !time.Now().Before(deadline) {
				break
			}
			status, _ = manager.WaitForChange(2 * time.Second)
		}
		if status.Phase == phaseReady && status.HasURLs {
			w.Header().Set("Cache-Control", "no-store")
			w.Header().Set("Referrer-Policy", "no-referrer")
			http.Redirect(w, r, status.URLs.Local, http.StatusFound)
			return
		}
		body := renderStatusPage(status)
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Content-Length", fmt.Sprint(len(body)))
		_, _ = w.Write(body)
	})
}

func phaseLabel(phase backendPhase) string {
	switch phase {
	case phaseConfig:
		return "正在准备配置"
	case phasePlugins:
		return "正在准备插件"
	case phaseDsh:
		return "正在启动 dsh"
	case phaseRelay:
		return "正在启动本机入口"
	case phaseReady:
		return "就绪"
	case phaseRestarting:
		return "正在按远程入口变更重启"
	case phaseStopping:
		return "正在停止后台"
	case phaseFailed:
		return "后台异常"
	case phaseOffline:
		return "后台未运行"
	}
	return string(phase)
}

func phaseAdvice(status backendStatus) string {
	switch status.Phase {
	case phaseFailed:
		if status.Detail != "" {
			return "原因：" + status.Detail
		}
		return "原因未知，可从托盘菜单「查看日志」了解详情。"
	case phaseOffline:
		return "从托盘菜单选择「启动后台」重新开始（应用会自动重启并进入工作台）。"
	case phaseStopping:
		return "后台正在按既有顺序回收子进程；完成后可从托盘重新启动。"
	case phaseRestarting:
		return "远程入口变更会短暂重启 dsh；本机入口保持不变。"
	}
	return ""
}

// renderStatusPage 输出轻量的启动/故障页（只描述阶段与地址，不带凭据）。
// 页面绝不自刷新或用 JS 跳转：那类跳转进不了 relay（见 statusHandler 注释）。
func renderStatusPage(status backendStatus) []byte {
	var builder strings.Builder
	builder.WriteString(`<!doctype html><html lang="zh-CN"><meta charset="utf-8">` +
		`<title>DSH 工作站</title>` +
		`<style>
:root{color-scheme:light dark}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font:14px/1.7 "Segoe UI","Microsoft YaHei",system-ui,sans-serif;background:#f5f5f5;color:#1f1f1f}
@media (prefers-color-scheme:dark){body{background:#1b1b1b;color:#e6e6e6}}
main{max-width:520px;padding:32px}
h1{font-size:18px;margin:0 0 4px;display:flex;align-items:center;gap:10px}
h1 .logo{display:flex}
h1 .logo svg{width:22px;height:22px}
.phase{font-weight:600;margin:14px 0 2px}
.detail{opacity:.75;margin:2px 0}
.urls{margin-top:16px;padding-top:12px;border-top:1px solid rgba(127,127,127,.35)}
.urls a{color:inherit}
small{opacity:.6}
</style><main><h1><span class="logo">` + chromebarLogoSVG + `</span>DSH 工作站</h1>`)

	phase := html.EscapeString(phaseLabel(status.displayPhase()))
	builder.WriteString(`<p class="phase">` + phase + `</p>`)
	if status.Detail != "" {
		builder.WriteString(`<p class="detail">` + html.EscapeString(status.Detail) + `</p>`)
	}
	if advice := phaseAdvice(status); advice != "" {
		builder.WriteString(`<p class="detail">` + html.EscapeString(advice) + `</p>`)
	}
	if status.HasURLs && (status.Phase == phaseReady || status.Phase == phasePlugins || status.Phase == phaseDsh || status.Phase == phaseRelay) {
		builder.WriteString(`<div class="urls"><a href="` + html.EscapeString(status.URLs.Local) + `">在系统浏览器中打开</a>` +
			` · <a href="` + html.EscapeString(status.URLs.Admin) + `">远程管理</a>` +
			`<br><small>本机入口 <code>` + html.EscapeString(status.URLs.Local) + `</code></small></div>`)
	}
	builder.WriteString(`</main>`)
	return []byte(builder.String())
}
