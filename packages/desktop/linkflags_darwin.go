//go:build darwin && cgo

// wails v2.16.0 的 WailsContext.m（文件对话框过滤）引用 UniformTypeIdentifiers
// 的 UTType，但其 cgo 指令只声明 Foundation/Cocoa/WebKit/AppKit；Xcode 26 SDK
// 收紧后链接期 _OBJC_CLASS_$_UTType 未定义。上游未发修复前，在 main 包补一次
// 框架声明，cgo LDFLAGS 会合并进最终链接命令。
package main

/*
#cgo darwin LDFLAGS: -framework UniformTypeIdentifiers
*/
import "C"
