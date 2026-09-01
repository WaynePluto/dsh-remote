package main

import (
	"syscall"
	"unicode/utf16"
	"unsafe"
)

const (
	// Per-user autostart. HKCU needs no elevation, and the stack is a per-user
	// thing: it serves that user's dsh, from that user's home directory.
	runKeyPath   = `Software\Microsoft\Windows\CurrentVersion\Run`
	runValueName = "dsh-remote"
)

// autostartEnabled reads the registry every time the menu is opened. The
// registry is the truth — the user may have edited it, or a cleanup tool may
// have removed the entry — and a cached copy could only ever lie about it.
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

// setAutostart writes the executable's current absolute path, so a package that
// was moved and switched on again points at where it is now.
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
	// Quoted: the path almost always contains spaces, and the Run key hands its
	// value to CreateProcess as a command line.
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
