// Win32 bindings for the tray launcher.
//
// Everything is reached through syscall.NewLazyDLL rather than a helper module:
// the green package must stay free of dependencies (铁律 3), and every pixel
// this program shows is drawn by Windows itself — there is no drawing code
// anywhere in this directory, only calls into user32 / shell32 / kernel32.
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

	// Balloon click, delivered only when the icon asks for NOTIFYICON_VERSION.
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

	// Version 3 keeps the classic message packing (lParam is the mouse
	// message) while enabling the balloon notifications version 0 lacks.
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

	// The icon group id written by packaging/make-icons.mjs. Passed to
	// LoadImage as MAKEINTRESOURCE, which is just the integer itself.
	appIconResourceID uintptr = 1

	idiApplication uintptr = 32512
	smCXSmIcon     uintptr = 49
	smCYSmIcon     uintptr = 50

	swShowNormal uintptr = 1

	errorAlreadyExists syscall.Errno = 183

	// Console applications started by this GUI process get an invisible console
	// of their own, which is what makes the graceful Ctrl+C shutdown in stack.go possible.
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

// utf16Ptr converts to the UTF-16 every W entry point expects. A string with an
// embedded NUL is the only failure, and none of the literals here has one, so
// the error collapses into an empty string rather than into every call site.
func utf16Ptr(text string) *uint16 {
	pointer, err := syscall.UTF16PtrFromString(text)
	if err != nil {
		empty := []uint16{0}
		return &empty[0]
	}
	return pointer
}

// setUTF16 fills one of the fixed-size fields of NOTIFYICONDATAW, truncating
// rather than overflowing; the trailing NUL is what Windows reads to stop.
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

// shellOpen hands a URL or a file to whatever the user configured for it.
// Only ever called from a menu item: the launcher never opens a browser on its
// own (D6).
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
	// ShellExecuteW reports success as "greater than 32"; the values at or below
	// that are its error codes, not handles.
	if result > 32 {
		return nil
	}
	return fmt.Errorf("ShellExecuteW 返回 %d", result)
}

// shellOpenWith runs one specific program on a file, for when the file type has
// no association at all and shellOpen would only offer the "open with" dialog.
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

// acquireSingleInstance returns the mutex handle plus whether somebody already
// holds it. Two stacks would fight over the same ports, so the second copy has
// to say so and leave.
func acquireSingleInstance(name string) (syscall.Handle, bool, error) {
	handle, _, err := procCreateMutexW.Call(0, 0, uintptr(unsafe.Pointer(utf16Ptr(name))))
	if handle == 0 {
		return 0, false, err
	}
	return syscall.Handle(handle), err == errorAlreadyExists, nil
}

// createKillOnCloseJob makes the job every child of one run is assigned to.
// JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE is the whole point: the tray process holds
// the only handle, so if it is killed outright — no chance to run any cleanup —
// Windows still takes dsh, the relay, the connector and every shell dsh spawned
// down with it. taskkill can only ever be the polite path, never the guarantee.
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

// requestConsoleShutdown asks the launcher to shut down the way Ctrl+C in a
// terminal does, which is the only shutdown it implements (SIGINT), and the one
// that stops connector -> relay -> dsh in that order.
//
// A -H windowsgui process has no console, so it cannot signal anyone; borrowing
// the child's own (invisible, from CREATE_NO_WINDOW) console is what makes this
// possible. The event goes to every process on that console, which is exactly
// what pressing Ctrl+C in a terminal running the stack does too. The ignore flag
// is set before attaching, because the event would otherwise come back to this
// process and the Go runtime would exit on it.
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

// registerTaskbarCreatedMessage returns the broadcast Explorer sends after it
// restarts; every tray icon has to be added again when it arrives.
func registerTaskbarCreatedMessage() uint32 {
	message, _, _ := procRegisterWindowMessage.Call(uintptr(unsafe.Pointer(utf16Ptr("TaskbarCreated"))))
	return uint32(message)
}

// moduleHandle is the HINSTANCE of this executable, which RegisterClassEx and
// CreateWindowEx both want.
func moduleHandle() (syscall.Handle, error) {
	handle, _, err := procGetModuleHandleW.Call(0)
	if handle == 0 {
		return 0, err
	}
	return syscall.Handle(handle), nil
}
