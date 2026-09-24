package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestParsePreviewOptions(t *testing.T) {
	config, err := parsePreviewOptions([]string{"--attach", "--relay-url", "http://127.0.0.1:30810/"})
	if err != nil {
		t.Fatal(err)
	}
	if config.relayURL != "http://127.0.0.1:30810/" || config.adminURL != "http://127.0.0.1:30810/_admin" {
		t.Fatalf("地址解析错误: %+v", config)
	}
	if _, err := parsePreviewOptions([]string{"--selfcheck"}); err != nil {
		t.Fatalf("自检不应要求运行中的后台: %v", err)
	}
}

func TestRejectPreviewOptions(t *testing.T) {
	cases := [][]string{
		nil,
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
	}
	for _, arguments := range cases {
		if config, err := parsePreviewOptions(arguments); err == nil {
			t.Errorf("错误接受参数 %q: %+v", arguments, config)
		}
	}
}

func TestBootstrapOnlyRedirectsFromRoot(t *testing.T) {
	handler := bootstrapHandler("http://127.0.0.1:30809/")
	request := httptest.NewRequest(http.MethodGet, "http://wails.localhost/", nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusFound || response.Header().Get("Location") != "http://127.0.0.1:30809/" {
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
