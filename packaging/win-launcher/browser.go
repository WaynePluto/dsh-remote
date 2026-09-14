// 托盘菜单「打开 dsh 界面 / 打开管理界面」选择浏览器的偏好：
// 优先本机 Chrome，找不到再交给系统默认浏览器。
package main

import (
	"os"
	"syscall"
	"unsafe"
)

// Chrome 安装器自己写下的 App Paths 键。查它而不是硬编码
// Program Files 下的位置：没有管理员权限的机器装的是
// 按用户版本，路径在 %LOCALAPPDATA% 里，只有注册表知道。
const chromeAppPaths = `Software\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe`

// findChrome 返回本机 Chrome 的完整路径，找不到时返回空字符串。
// HKCU 在前：两种安装并存时它是当前用户实际点开的那一个，
// 这也是 ShellExecute 解析裸 exe 名时的顺序。每次打开菜单
// 现查现用、不缓存——与 autostartEnabled 同理，注册表才是
// 真实状态。读到路径后仍要确认文件存在：卸载残留的键
// 不该拦住默认浏览器。
func findChrome() string {
	for _, root := range []syscall.Handle{hkeyCurrentUser, hkeyLocalMachine} {
		path, ok := appPathsDefault(root, chromeAppPaths)
		if ok {
			if _, err := os.Stat(path); err == nil {
				return path
			}
		}
	}
	return ""
}

// appPathsDefault 读取 App Paths 键的默认值，即 exe 的完整路径。
// 名称传 nil 查询的就是默认值；先问长度再取数据是
// RegQueryValueEx 的标准两段式用法。
func appPathsDefault(root syscall.Handle, subkey string) (string, bool) {
	var key syscall.Handle
	if err := syscall.RegOpenKeyEx(root, utf16Ptr(subkey), 0, keyQueryValue, &key); err != nil {
		return "", false
	}
	defer syscall.RegCloseKey(key)
	var size uint32
	if err := syscall.RegQueryValueEx(key, nil, nil, nil, nil, &size); err != nil || size < 2 {
		return "", false
	}
	buffer := make([]uint16, size/2)
	if err := syscall.RegQueryValueEx(key, nil, nil, nil, (*byte)(unsafe.Pointer(&buffer[0])), &size); err != nil {
		return "", false
	}
	// UTF16ToString 在第一个 NUL 处停止，正好剥掉 REG_SZ 的终止符。
	return syscall.UTF16ToString(buffer), true
}
