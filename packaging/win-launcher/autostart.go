package main

import (
	"syscall"
	"unicode/utf16"
	"unsafe"
)

const (
	// 按用户设置开机自启动。HKCU 无需提权；stack 也是按用户隔离的
	// 它服务于该用户、运行在该用户 home 目录中的 dsh。
	runKeyPath   = `Software\Microsoft\Windows\CurrentVersion\Run`
	runValueName = "dsh-remote"
)

// autostartEnabled 每次打开菜单都读取注册表。
// 注册表才是真实状态——用户可能手动改过它，清理工具也可能
// 删除了条目；缓存只会造成错误显示。
func autostartEnabled() bool {
	var key syscall.Handle
	if err := syscall.RegOpenKeyEx(hkeyCurrentUser, utf16Ptr(runKeyPath), 0, keyQueryValue, &key); err != nil {
		return false
	}
	defer syscall.RegCloseKey(key)
	var kind uint32
	var size uint32
	err := syscall.RegQueryValueEx(key, utf16Ptr(runValueName), nil, &kind, nil, &size)
	return err == nil
}

// setAutostart 写入可执行文件当前的绝对路径，这样软件包
// 移动后重新开启自启动，指向的就是新位置。
func setAutostart(executable string, enabled bool) error {
	var key syscall.Handle
	if err := syscall.RegOpenKeyEx(hkeyCurrentUser, utf16Ptr(runKeyPath), 0, keySetValue, &key); err != nil {
		return err
	}
	defer syscall.RegCloseKey(key)
	name := utf16Ptr(runValueName)
	if !enabled {
		result, _, _ := procRegDeleteValueW.Call(uintptr(key), uintptr(unsafe.Pointer(name)))
		if result != 0 {
			return syscall.Errno(result)
		}
		return nil
	}
	// 加引号：路径几乎总会包含空格，而 Run 键会把它的
	// 值作为命令行交给 CreateProcess。
	value := utf16.Encode([]rune(`"` + executable + `"`))
	value = append(value, 0)
	result, _, _ := procRegSetValueExW.Call(
		uintptr(key),
		uintptr(unsafe.Pointer(name)),
		0,
		uintptr(regSZ),
		uintptr(unsafe.Pointer(&value[0])),
		uintptr(len(value)*2),
	)
	if result != 0 {
		return syscall.Errno(result)
	}
	return nil
}
