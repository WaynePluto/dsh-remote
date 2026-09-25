package main

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"net/url"
	"strconv"
)

type runMode int

const (
	// modeStandalone 默认模式：桌面壳发现随包载荷并托管自己的 launcher 后台。
	modeStandalone runMode = iota
	// modeAttach 开发模式：附着到已运行的栈（pnpm dev:desktop），不管理它的进程。
	modeAttach
)

type runOptions struct {
	mode      runMode
	relayURL  string
	adminURL  string
	appDir    string
	selfCheck bool
}

func parseRunOptions(arguments []string) (runOptions, error) {
	flags := flag.NewFlagSet("dsh-station-desktop", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	attach := flags.Bool("attach", false, "开发模式：连接到已有的开发栈，不管理它的进程")
	address := flags.String("relay-url", "http://127.0.0.1:31809/", "现有开发栈的本机 relay URL（仅 --attach；默认端口见 scripts/local-config.mjs）")
	appDir := flags.String("app-dir", "", "覆盖随包载荷目录（package/ 的父目录）；默认从 exe 位置发现")
	selfCheck := flags.Bool("selfcheck", false, "只检查参数与载荷发现，不启动窗口或后台")
	if err := flags.Parse(arguments); err != nil {
		return runOptions{}, err
	}
	if len(flags.Args()) != 0 {
		return runOptions{}, errors.New("不接受位置参数")
	}

	if *attach {
		parsed, err := parseLoopbackRelayURL(*address)
		if err != nil {
			return runOptions{}, err
		}
		if *appDir != "" {
			return runOptions{}, errors.New("--app-dir 只在独立模式下有效；--attach 使用现有开发栈")
		}
		return runOptions{
			mode:      modeAttach,
			relayURL:  parsed.relay,
			adminURL:  parsed.admin,
			selfCheck: *selfCheck,
		}, nil
	}
	if *address != "http://127.0.0.1:31809/" {
		return runOptions{}, errors.New("--relay-url 只在 --attach 模式下有效；独立模式的后台自己决定端口")
	}
	return runOptions{mode: modeStandalone, appDir: *appDir, selfCheck: *selfCheck}, nil
}

type parsedRelay struct {
	relay string
	admin string
}

func parseLoopbackRelayURL(value string) (parsedRelay, error) {
	parsed, err := url.Parse(value)
	if err != nil || parsed.Scheme != "http" || parsed.User != nil || parsed.Hostname() != "127.0.0.1" || parsed.Path != "/" || parsed.RawQuery != "" || parsed.Fragment != "" {
		return parsedRelay{}, errors.New("--relay-url 只能是 http://127.0.0.1:<端口>/")
	}
	port, err := strconv.Atoi(parsed.Port())
	if err != nil || port < 1 || port > 65535 || parsed.Host != fmt.Sprintf("127.0.0.1:%d", port) {
		return parsedRelay{}, errors.New("--relay-url 必须使用规范的 1–65535 端口")
	}
	relay := parsed.String()
	admin := parsed.ResolveReference(&url.URL{Path: "/_admin"}).String()
	return parsedRelay{relay: relay, admin: admin}, nil
}
