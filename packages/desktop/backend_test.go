package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func newTestManager() *backendManager {
	return newBackendManager(desktopPayload{}, "token", nil)
}

func TestApplyLineAcceptsStatusMessages(t *testing.T) {
	manager := newTestManager()
	manager.applyLine(`{"type":"status","protocol":1,"phase":"ready","detail":"就绪","urls":{"local":"http://127.0.0.1:30809/","admin":"http://127.0.0.1:30809/_admin","dsh":"http://127.0.0.1:3080/"},"adminReady":false}`)
	status := manager.Status()
	if status.Phase != phaseReady || !status.HasURLs || status.AdminReady {
		t.Fatalf("状态解析错误: %+v", status)
	}
	if status.URLs.Local != "http://127.0.0.1:30809/" || status.URLs.Admin != "http://127.0.0.1:30809/_admin" {
		t.Fatalf("URL 解析错误: %+v", status.URLs)
	}
	// 非 ready 阶段不带 urls 时不得残留上一阶段的 URL。
	manager.applyLine(`{"type":"status","protocol":1,"phase":"restarting"}`)
	status = manager.Status()
	if status.HasURLs {
		t.Fatalf("无 URL 消息不应保留旧 URL: %+v", status)
	}
}

func TestApplyLineRejectsUnknownProtocol(t *testing.T) {
	manager := newTestManager()
	before := manager.Status()
	manager.applyLine(`{"type":"status","protocol":2,"phase":"ready"}`)
	after := manager.Status()
	if after.Phase != before.Phase {
		t.Fatalf("未知协议版本不得改变状态: %+v → %+v", before, after)
	}
}

func TestApplyLineHandlesStartupFailure(t *testing.T) {
	manager := newTestManager()
	manager.applyLine(`{"type":"exit","protocol":1,"message":"配置文件无效"}`)
	status := manager.Status()
	if status.Phase != phaseFailed || status.Detail != "配置文件无效" {
		t.Fatalf("启动失败未进入 failed: %+v", status)
	}
}

func TestStatusHandlerRedirectsWhenReady(t *testing.T) {
	manager := newTestManager()
	manager.setStatus(backendStatus{
		Phase:   phaseReady,
		HasURLs: true,
		URLs:    backendURLs{Local: "http://127.0.0.1:30809/", Admin: "http://127.0.0.1:30809/_admin", Dsh: "http://127.0.0.1:3080/"},
	})
	handler := statusHandler(manager)
	request := httptest.NewRequest(http.MethodGet, "http://wails.localhost/", nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusFound || response.Header().Get("Location") != "http://127.0.0.1:30809/" {
		t.Fatalf("就绪后应 302 进本机 relay: %d %q", response.Code, response.Header().Get("Location"))
	}
}

func TestStatusHandlerRendersFailurePageImmediately(t *testing.T) {
	manager := newTestManager()
	manager.setStatus(backendStatus{Phase: phaseFailed, Detail: "端口被占用"})
	handler := statusHandler(manager)
	request := httptest.NewRequest(http.MethodGet, "http://wails.localhost/", nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("失败应立即返回状态页: %d", response.Code)
	}
	body := response.Body.String()
	if !contains(body, "后台异常") || !contains(body, "端口被占用") {
		t.Fatalf("状态页缺少失败信息: %s", body)
	}
	// 非 GET 请求与业务路径一律 404，AssetServer 不碰业务。
	request = httptest.NewRequest(http.MethodPost, "http://wails.localhost/", nil)
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusNotFound {
		t.Fatalf("非 GET 应 404: %d", response.Code)
	}
}

func TestStatusHandlerHoldsUntilReady(t *testing.T) {
	manager := newTestManager()
	handler := statusHandler(manager)
	request := httptest.NewRequest(http.MethodGet, "http://wails.localhost/", nil)
	// 在持有期间后台变为就绪：初始导航应被 302 放行进 relay。
	go func() {
		for i := 0; i < 10 && manager.Status().Phase != phaseDsh; i++ {
			time.Sleep(20 * time.Millisecond)
		}
		manager.setStatus(backendStatus{
			Phase:   phaseReady,
			HasURLs: true,
			URLs:    backendURLs{Local: "http://127.0.0.1:30809/", Admin: "http://127.0.0.1:30809/_admin", Dsh: "http://127.0.0.1:3080/"},
		})
	}()
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusFound || response.Header().Get("Location") != "http://127.0.0.1:30809/" {
		t.Fatalf("持有期间就绪应 302 进 relay: %d %q", response.Code, response.Header().Get("Location"))
	}
}

func contains(haystack, needle string) bool {
	return len(haystack) >= len(needle) && (haystack == needle || len(needle) == 0 || indexOf(haystack, needle) >= 0)
}

func indexOf(haystack, needle string) int {
	for i := 0; i+len(needle) <= len(haystack); i++ {
		if haystack[i:i+len(needle)] == needle {
			return i
		}
	}
	return -1
}
