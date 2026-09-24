//go:build !windows

package main

import "errors"

// 非 Windows 平台的托盘/单实例暂缺（S10 平台适配）：
// 窗口关闭直接退出应用并停止自有后台，避免窗口关掉后无处找回。

type desktopTrayCallbacks struct {
	onShow    func()
	onBrowser func()
	onAdmin   func()
	onStart   func()
	onStop    func()
	onRestart func()
	onQuit    func()
}

type desktopTrayHandle struct{}

func (*desktopTrayHandle) Stop() {}

func (*desktopTrayHandle) SetTip(string) {}

func startWindowsTray(desktopTrayCallbacks) (*desktopTrayHandle, error) {
	return nil, errors.New("此平台还没有实现常驻托盘（计划 S10.2）")
}

func acquireSingleInstance() (bool, func()) {
	return true, func() {}
}
