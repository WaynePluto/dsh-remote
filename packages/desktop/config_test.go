package main

import (
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestParseRunOptionsAttach(t *testing.T) {
	config, err := parseRunOptions([]string{"--attach", "--relay-url", "http://127.0.0.1:30810/"})
	if err != nil {
		t.Fatal(err)
	}
	if config.mode != modeAttach || config.relayURL != "http://127.0.0.1:30810/" || config.adminURL != "http://127.0.0.1:30810/_admin" {
		t.Fatalf("地址解析错误: %+v", config)
	}
	selfCheck, err := parseRunOptions([]string{"--attach", "--selfcheck"})
	if err != nil {
		t.Fatalf("自检不应要求运行中的后台: %v", err)
	}
	if !selfCheck.selfCheck {
		t.Fatal("自检标记丢失")
	}
	standalone, err := parseRunOptions([]string{"--selfcheck"})
	if err != nil || standalone.mode != modeStandalone {
		t.Fatalf("默认应为独立模式: %+v %v", standalone, err)
	}
}

func TestRejectRunOptions(t *testing.T) {
	cases := [][]string{
		{"--attach", "other"},
		{"--attach", "--relay-url", "http://localhost:30809/"},
		{"--attach", "--relay-url", "http://127.0.0.2:30809/"},
		{"--attach", "--relay-url", "https://127.0.0.1:30809/"},
		{"--attach", "--relay-url", "http://127.0.0.1:30809@outside.example/"},
		{"--attach", "--relay-url", "http://127.0.0.1:030809/"},
		{"--attach", "--relay-url", "http://127.0.0.1:0/"},
		{"--attach", "--relay-url", "http://127.0.0.1:30809/#frag"},
		{"--attach", "--relay-url", "http://127.0.0.1:30809/?token=secret"},
		{"--attach", "--relay-url", "http://127.0.0.1:30809/_admin"},
		{"--attach", "--app-dir", "C:/tmp"},
		{"--relay-url", "http://127.0.0.1:30810/"},
	}
	for _, arguments := range cases {
		if config, err := parseRunOptions(arguments); err == nil {
			t.Errorf("错误接受参数 %q: %+v", arguments, config)
		}
	}
}

func TestBootstrapOnlyRedirectsFromRoot(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	target := "http://" + listener.Addr().String() + "/"
	handler := bootstrapHandler(target)
	request := httptest.NewRequest(http.MethodGet, "http://wails.localhost/", nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusFound || response.Header().Get("Location") != target {
		t.Fatalf("首次 HTTP 跳转未定位到本机 relay: %d %q", response.Code, response.Header().Get("Location"))
	}
	if response.Header().Get("Cache-Control") != "no-store" || response.Header().Get("Referrer-Policy") != "no-referrer" {
		t.Fatal("引导页必须禁止缓存和传递来源")
	}
	for _, path := range []string{"/api/remote.mux", "/plugins/client.js", "/_admin"} {
		request := httptest.NewRequest(http.MethodGet, "http://wails.localhost"+path, nil)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != http.StatusNotFound {
			t.Errorf("AssetServer 不应处理业务路径 %s: %d", path, response.Code)
		}
	}
}

func TestBootstrapHoldsUntilRelayListensThenTimesOut(t *testing.T) {
	handler := bootstrapHandlerWithHold("http://127.0.0.1:1/", 150*time.Millisecond)
	request := httptest.NewRequest(http.MethodGet, "http://wails.localhost/", nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("超时应回答状态页: %d", response.Code)
	}
	if body := response.Body.String(); !contains(body, "开发栈") {
		t.Fatalf("超时页应说明开发栈未监听: %s", body)
	}
}
