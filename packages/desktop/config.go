package main

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"net/url"
	"strconv"
)

type previewOptions struct {
	relayURL  string
	adminURL  string
	selfCheck bool
}

func parsePreviewOptions(arguments []string) (previewOptions, error) {
	flags := flag.NewFlagSet("dsh-remote-desktop", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	attach := flags.Bool("attach", false, "连接到已有的开发栈，不管理它的进程")
	address := flags.String("relay-url", "http://127.0.0.1:30809/", "现有开发栈的本机 relay URL")
	selfCheck := flags.Bool("selfcheck", false, "只检查参数和入口，不启动桌面窗口")
	if err := flags.Parse(arguments); err != nil {
		return previewOptions{}, err
	}
	if len(flags.Args()) != 0 {
		return previewOptions{}, errors.New("不接受位置参数")
	}
	if !*attach && !*selfCheck {
		return previewOptions{}, errors.New("桌面预览版仅支持 --attach；必须先启动现有开发栈")
	}
	parsed, err := url.Parse(*address)
	if err != nil || parsed.Scheme != "http" || parsed.User != nil || parsed.Hostname() != "127.0.0.1" || parsed.Path != "/" || parsed.RawQuery != "" || parsed.Fragment != "" {
		return previewOptions{}, errors.New("--relay-url 只能是 http://127.0.0.1:<端口>/")
	}
	port, err := strconv.Atoi(parsed.Port())
	if err != nil || port < 1 || port > 65535 || parsed.Host != fmt.Sprintf("127.0.0.1:%d", port) {
		return previewOptions{}, errors.New("--relay-url 必须使用规范的 1–65535 端口")
	}
	return previewOptions{
		relayURL:  parsed.String(),
		adminURL:  parsed.ResolveReference(&url.URL{Path: "/_admin"}).String(),
		selfCheck: *selfCheck,
	}, nil
}
