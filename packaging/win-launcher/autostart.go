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
	// 自启动条目用这个参数标记“这次运行是登录时拉起的”，
	// 托盘据此不弹「已启动」通知。launcher 不认识这个参数，
	// 转发前已由 main.go 去掉。
	autostartFlag = "--autostart"
)

// autostartCommand 返回 Run 键里注册的完整命令行；空串表示没有条目。
func autostartCommand() string {
	var key syscall.Handle
	if err := syscall.RegOpenKeyEx(hkeyCurrentUser, utf16Ptr(runKeyPath), 0, keyQueryValue, &key); err != nil {
		return ""
	}
	defer syscall.RegCloseKey(key)
	var size uint32
	if err := syscall.RegQueryValueEx(key, utf16Ptr(runValueName), nil, nil, nil, &size); err != nil {
		return ""
	}
	if size == 0 {
		return ""
	}
	buffer := make([]byte, size)
	if err := syscall.RegQueryValueEx(key, utf16Ptr(runValueName), nil, nil, &buffer[0], &size); err != nil {
		return ""
	}
	// REG_SZ 以 NUL 结尾且长度含 NUL；Decode 前去掉。
	runes := utf16.Decode(unsafe.Slice((*uint16)(unsafe.Pointer(&buffer[0])), int(size)/2))
	for len(runes) > 0 && runes[len(runes)-1] == 0 {
		runes = runes[:len(runes)-1]
	}
	return string(runes)
}

// autostartEnabled 每次打开菜单都读取注册表。
// 注册表才是真实状态——用户可能手动改过它，清理工具也可能
// 删除了条目；缓存只会造成错误显示。
func autostartEnabled() bool {
	return autostartCommand() != ""
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
	// 值作为命令行交给 CreateProcess。--autostart 让本次
	// 运行知道自己是登录时被拉起的，从而保持静默。
	value := utf16.Encode([]rune(`"` + executable + `" ` + autostartFlag))
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

// upgradeAutostartEntry 为旧格式（不带 --autostart）的自启动条目补上
// 参数：这些条目是本程序在该参数存在之前写下的，不补的话它们每次
// 登录都会像手动双击一样弹「已启动」通知。只改写命令行恰好只指向
// 本可执行文件的条目；用户手写或另有用途的条目不动。
func upgradeAutostartEntry(executable string, log *rotatingLog) {
	if autostartCommand() != `"`+executable+`"` {
		return
	}
	if err := setAutostart(executable, true); err != nil {
		log.printf("为自启动条目补 %s 失败：%v", autostartFlag, err)
		return
	}
	log.printf("已为自启动条目补上 %s：开机登录不再弹「已启动」通知", autostartFlag)
}
