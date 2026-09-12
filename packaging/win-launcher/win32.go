// 托盘启动器的 Win32 绑定。
//
// 所有调用都通过 syscall.NewLazyDLL 进入，而不是依赖辅助模块：
// 绿色包必须不带依赖（铁律 3），本程序显示的每个像素
// 都由 Windows 自己绘制；
// 本目录没有绘图代码，只有对 user32 / shell32 / kernel32 的调用。
package main

import (
	"fmt"
	"syscall"
	"unicode/utf16"
	"unsafe"
)

var (
	kernel32 = syscall.NewLazyDLL("kernel32.dll")
	user32   = syscall.NewLazyDLL("user32.dll")
	shell32  = syscall.NewLazyDLL("shell32.dll")
	advapi32 = syscall.NewLazyDLL("advapi32.dll")

	procCreateMutexW             = kernel32.NewProc("CreateMutexW")
	procGetModuleHandleW         = kernel32.NewProc("GetModuleHandleW")
	procCreateJobObjectW         = kernel32.NewProc("CreateJobObjectW")
	procSetInformationJobObject  = kernel32.NewProc("SetInformationJobObject")
	procAssignProcessToJobObject = kernel32.NewProc("AssignProcessToJobObject")
	procTerminateJobObject       = kernel32.NewProc("TerminateJobObject")
	procAttachConsole            = kernel32.NewProc("AttachConsole")
	procFreeConsole              = kernel32.NewProc("FreeConsole")
	procSetConsoleCtrlHandler    = kernel32.NewProc("SetConsoleCtrlHandler")
	procGenerateConsoleCtrlEvent = kernel32.NewProc("GenerateConsoleCtrlEvent")

	procRegisterClassExW      = user32.NewProc("RegisterClassExW")
	procCreateWindowExW       = user32.NewProc("CreateWindowExW")
	procDefWindowProcW        = user32.NewProc("DefWindowProcW")
	procDestroyWindow         = user32.NewProc("DestroyWindow")
	procGetMessageW           = user32.NewProc("GetMessageW")
	procTranslateMessage      = user32.NewProc("TranslateMessage")
	procDispatchMessageW      = user32.NewProc("DispatchMessageW")
	procPostQuitMessage       = user32.NewProc("PostQuitMessage")
	procPostMessageW          = user32.NewProc("PostMessageW")
	procRegisterWindowMessage = user32.NewProc("RegisterWindowMessageW")
	procLoadImageW            = user32.NewProc("LoadImageW")
	procLoadIconW             = user32.NewProc("LoadIconW")
	procDestroyIcon           = user32.NewProc("DestroyIcon")
	procGetSystemMetrics      = user32.NewProc("GetSystemMetrics")
	procCreatePopupMenu       = user32.NewProc("CreatePopupMenu")
	procAppendMenuW           = user32.NewProc("AppendMenuW")
	procDestroyMenu           = user32.NewProc("DestroyMenu")
	procTrackPopupMenu        = user32.NewProc("TrackPopupMenu")
	procSetMenuDefaultItem    = user32.NewProc("SetMenuDefaultItem")
	procSetForegroundWindow   = user32.NewProc("SetForegroundWindow")
	procGetCursorPos          = user32.NewProc("GetCursorPos")
	procMessageBoxW           = user32.NewProc("MessageBoxW")

	procShellNotifyIconW = shell32.NewProc("Shell_NotifyIconW")
	procShellExecuteW    = shell32.NewProc("ShellExecuteW")

	procRegSetValueExW  = advapi32.NewProc("RegSetValueExW")
	procRegDeleteValueW = advapi32.NewProc("RegDeleteValueW")
)

const (
	wmDestroy uint32 = 0x0002
	wmClose   uint32 = 0x0010
	wmNull    uint32 = 0x0000
	wmApp     uint32 = 0x8000

	wmLButtonDblClk uint32 = 0x0203
	wmRButtonUp     uint32 = 0x0205
	wmContextMenu   uint32 = 0x007B

	// 仅当图标请求 NOTIFYICON_VERSION 时才会收到的气球通知点击。
	ninBalloonUserClick uint32 = 0x0405

	nimAdd        uint32 = 0x00000000
	nimModify     uint32 = 0x00000001
	nimDelete     uint32 = 0x00000002
	nimSetVersion uint32 = 0x00000004

	nifMessage uint32 = 0x00000001
	nifIcon    uint32 = 0x00000002
	nifTip     uint32 = 0x00000004
	nifInfo    uint32 = 0x00000010

	niifInfo uint32 = 0x00000001

	// 版本 3 保留经典的消息打包方式（lParam 是鼠标
	// 消息），同时启用版本 0 不具备的气球通知。
	notifyIconVersion uint32 = 3

	mfString    uintptr = 0x00000000
	mfGrayed    uintptr = 0x00000001
	mfChecked   uintptr = 0x00000008
	mfSeparator uintptr = 0x00000800

	tpmLeftAlign   uintptr = 0x0000
	tpmRightButton uintptr = 0x0002
	tpmBottomAlign uintptr = 0x0020
	tpmReturnCmd   uintptr = 0x0100
	tpmNonNotify   uintptr = 0x0080

	mbOK                uint32 = 0x00000000
	mbIconError         uint32 = 0x00000010
	mbIconInformation   uint32 = 0x00000040
	mbSetForeground     uint32 = 0x00010000
	mbTopMost           uint32 = 0x00040000
	messageBoxAttention        = mbOK | mbSetForeground | mbTopMost

	imageIcon     uintptr = 1
	lrDefaultSize uintptr = 0x00000040
	lrShared      uintptr = 0x00008000

	// packaging/make-icons.mjs 写入的图标组 ID。它会传给
	// LoadImage 作为 MAKEINTRESOURCE，而它本身就是这个整数。
	appIconResourceID uintptr = 1

	idiApplication uintptr = 32512
	smCXSmIcon     uintptr = 49
	smCYSmIcon     uintptr = 50

	swShowNormal uintptr = 1

	errorAlreadyExists syscall.Errno = 183

	// 此 GUI 进程启动的控制台应用会获得一个不可见的控制台；
	// 这正是 stack.go 中温和处理 Ctrl+C 关闭的基础。
	createNoWindow uint32 = 0x08000000

	ctrlCEvent uintptr = 0

	jobObjectExtendedLimitClass  uintptr = 9
	jobObjectLimitKillOnJobClose uint32  = 0x00002000

	processTerminate uint32 = 0x0001
	processSetQuota  uint32 = 0x0100

	hkeyCurrentUser syscall.Handle = 0x80000001
	keyQueryValue   uint32         = 0x0001
	keySetValue     uint32         = 0x0002
	regSZ           uint32         = 1
)

type point struct {
	x int32
	y int32
}

type msg struct {
	hwnd    syscall.Handle
	message uint32
	wParam  uintptr
	lParam  uintptr
	time    uint32
	pt      point
}

type wndClassEx struct {
	cbSize        uint32
	style         uint32
	lpfnWndProc   uintptr
	cbClsExtra    int32
	cbWndExtra    int32
	hInstance     syscall.Handle
	hIcon         syscall.Handle
	hCursor       syscall.Handle
	hbrBackground syscall.Handle
	lpszMenuName  *uint16
	lpszClassName *uint16
	hIconSm       syscall.Handle
}

type notifyIconData struct {
	cbSize           uint32
	hWnd             syscall.Handle
	uID              uint32
	uFlags           uint32
	uCallbackMessage uint32
	hIcon            syscall.Handle
	szTip            [128]uint16
	dwState          uint32
	dwStateMask      uint32
	szInfo           [256]uint16
	uVersion         uint32
	szInfoTitle      [64]uint16
	dwInfoFlags      uint32
	guidItem         [16]byte
	hBalloonIcon     syscall.Handle
}

type ioCounters struct {
	readOperationCount  uint64
	writeOperationCount uint64
	otherOperationCount uint64
	readTransferCount   uint64
	writeTransferCount  uint64
	otherTransferCount  uint64
}

type jobObjectBasicLimitInformation struct {
	perProcessUserTimeLimit int64
	perJobUserTimeLimit     int64
	limitFlags              uint32
	minimumWorkingSetSize   uintptr
	maximumWorkingSetSize   uintptr
	activeProcessLimit      uint32
	affinity                uintptr
	priorityClass           uint32
	schedulingClass         uint32
}

type jobObjectExtendedLimitInformation struct {
	basicLimitInformation jobObjectBasicLimitInformation
	ioInfo                ioCounters
	processMemoryLimit    uintptr
	jobMemoryLimit        uintptr
	peakProcessMemoryUsed uintptr
	peakJobMemoryUsed     uintptr
}

// utf16Ptr 转换为所有 W 入口点要求的 UTF-16。包含
// 内嵌 NUL 是唯一会失败的情况，而这里的字面量都没有它，因此
// 错误会在此处折叠为空字符串，不会扩散到每个调用点。
func utf16Ptr(text string) *uint16 {
	pointer, err := syscall.UTF16PtrFromString(text)
	if err != nil {
		empty := []uint16{0}
		return &empty[0]
	}
	return pointer
}

// setUTF16 填充 NOTIFYICONDATAW 的固定大小字段，必要时截断
// 而不是溢出；末尾的 NUL 告诉 Windows 在哪里停止读取。
func setUTF16(destination []uint16, text string) {
	units := utf16.Encode([]rune(text))
	if len(units) > len(destination)-1 {
		units = units[:len(destination)-1]
	}
	copy(destination, units)
	destination[len(units)] = 0
}

func messageBox(text string, caption string, flags uint32) {
	procMessageBoxW.Call(
		0,
		uintptr(unsafe.Pointer(utf16Ptr(text))),
		uintptr(unsafe.Pointer(utf16Ptr(caption))),
		uintptr(flags|messageBoxAttention),
	)
}

// shellOpen 将 URL 或文件交给用户为其配置的程序。
// 它只会由菜单项调用：launcher 不会自行
// 打开浏览器（D6）。
func shellOpen(target string) error {
	verb := utf16Ptr("open")
	file := utf16Ptr(target)
	result, _, _ := procShellExecuteW.Call(
		0,
		uintptr(unsafe.Pointer(verb)),
		uintptr(unsafe.Pointer(file)),
		0,
		0,
		swShowNormal,
	)
	// ShellExecuteW 以“大于 32”表示成功；小于或等于该值的
	// 数字是错误码，不是句柄。
	if result > 32 {
		return nil
	}
	return fmt.Errorf("ShellExecuteW 返回 %d", result)
}

// shellOpenWith 在文件类型完全没有关联时，使用指定程序打开文件；
// 否则 shellOpen 只会提供“打开方式”对话框。
func shellOpenWith(program string, argument string) error {
	verb := utf16Ptr("open")
	file := utf16Ptr(program)
	parameters := utf16Ptr(`"` + argument + `"`)
	result, _, _ := procShellExecuteW.Call(
		0,
		uintptr(unsafe.Pointer(verb)),
		uintptr(unsafe.Pointer(file)),
		uintptr(unsafe.Pointer(parameters)),
		0,
		swShowNormal,
	)
	if result > 32 {
		return nil
	}
	return fmt.Errorf("ShellExecuteW 返回 %d", result)
}

// acquireSingleInstance 返回互斥体句柄，并说明是否已有其他实例持有它。
// 两个 stack 会争用相同端口，因此第二个副本必须提示用户
// 后退出。
func acquireSingleInstance(name string) (syscall.Handle, bool, error) {
	handle, _, err := procCreateMutexW.Call(0, 0, uintptr(unsafe.Pointer(utf16Ptr(name))))
	if handle == 0 {
		return 0, false, err
	}
	return syscall.Handle(handle), err == errorAlreadyExists, nil
}

// createKillOnCloseJob 为一次运行创建作业对象，并把该运行的每个子进程归入其中。
// JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE 的关键是：托盘进程持有
// 唯一句柄，因此即使它被直接杀掉、来不及执行清理，
// Windows 仍会连同 dsh、relay、connector 以及 dsh 派生的所有 shell 一起
// 结束。taskkill 只能作为温和路径，不能作为最终保证。
func createKillOnCloseJob() (syscall.Handle, error) {
	handle, _, err := procCreateJobObjectW.Call(0, 0)
	if handle == 0 {
		return 0, err
	}
	var limits jobObjectExtendedLimitInformation
	limits.basicLimitInformation.limitFlags = jobObjectLimitKillOnJobClose
	ok, _, err := procSetInformationJobObject.Call(
		handle,
		jobObjectExtendedLimitClass,
		uintptr(unsafe.Pointer(&limits)),
		unsafe.Sizeof(limits),
	)
	if ok == 0 {
		syscall.CloseHandle(syscall.Handle(handle))
		return 0, err
	}
	return syscall.Handle(handle), nil
}

func assignProcessToJob(job syscall.Handle, pid int) error {
	process, err := syscall.OpenProcess(processSetQuota|processTerminate, false, uint32(pid))
	if err != nil {
		return err
	}
	defer syscall.CloseHandle(process)
	ok, _, err := procAssignProcessToJobObject.Call(uintptr(job), uintptr(process))
	if ok == 0 {
		return err
	}
	return nil
}

func terminateJob(job syscall.Handle) {
	procTerminateJobObject.Call(uintptr(job), 1)
}

// requestConsoleShutdown 要求 launcher 像终端里的 Ctrl+C 一样关闭；
// 这是它唯一实现的关闭方式（SIGINT），也会
// 按 connector -> relay -> dsh 的顺序停止。
//
// -H windowsgui 进程没有控制台，无法向其他进程发信号；借用
// 子进程自己的控制台（由 CREATE_NO_WINDOW 创建且不可见）才能做到。
// 事件会发送给该控制台上的每个进程，和在终端
// 运行 stack 时按 Ctrl+C 完全一样。必须在附加前设置忽略标志，
// 否则事件会传回本进程，
// Go runtime 会因此退出。
func requestConsoleShutdown(pid int) bool {
	procSetConsoleCtrlHandler.Call(0, 1)
	defer procSetConsoleCtrlHandler.Call(0, 0)
	procFreeConsole.Call()
	attached, _, _ := procAttachConsole.Call(uintptr(uint32(pid)))
	if attached == 0 {
		return false
	}
	defer procFreeConsole.Call()
	sent, _, _ := procGenerateConsoleCtrlEvent.Call(ctrlCEvent, 0)
	return sent != 0
}

// registerTaskbarCreatedMessage 返回 Explorer 重启后发送的广播消息；
// 消息到达时必须重新添加每个托盘图标。
func registerTaskbarCreatedMessage() uint32 {
	message, _, _ := procRegisterWindowMessage.Call(uintptr(unsafe.Pointer(utf16Ptr("TaskbarCreated"))))
	return uint32(message)
}

// moduleHandle 返回本可执行文件的 HINSTANCE，这是 RegisterClassEx 和
// CreateWindowEx 都需要的值。
func moduleHandle() (syscall.Handle, error) {
	handle, _, err := procGetModuleHandleW.Call(0)
	if handle == 0 {
		return 0, err
	}
	return syscall.Handle(handle), nil
}
