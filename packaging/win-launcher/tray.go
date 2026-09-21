package main

import (
	"fmt"
	"strings"
	"sync/atomic"
	"syscall"
	"time"
	"unsafe"
)

const (
	windowClassName = "DshRemoteTrayWindow"

	// 本程序监视的两行 launcher 输出都来自启动横幅
	//（packages/launcher/src/banner.ts），而横幅只在 dsh 真正
	// 开始监听后打印，因此此刻点击通知里的地址是安全的：
	// - 「还没有管理员账号」说明设置向导仍在等待，是
	//   一切可用前用户唯一需要获知的状态；
	// - 「dsh 已就绪」说明界面已经可以打开，是回应
	//   双击之后「好像没反应」的时机。
	adminMissingMarker = "还没有管理员账号"
	readyMarker        = "dsh 已就绪"

	// 新装机器的横幅同时包含两个标记，只隔几毫秒；推迟
	// 一秒再决定发不发「已启动」，更重要的设置通知就
	// 有机会先标记自己、独占屏幕。
	startedNoticeDelay = time.Second
)

// 私有消息。Shell_NotifyIcon 回传到 wmTrayCallback；
// 另外两个用于把工作 goroutine 完成的任务转为 UI
// 并在拥有窗口的线程上处理。
const (
	wmTrayCallback  = wmApp + 1
	wmStateChanged  = wmApp + 2
	wmSetupNotice   = wmApp + 3
	wmStartedNotice = wmApp + 4
)

// 菜单命令标识符。TrackPopupMenu 直接返回它们
// （TPM_RETURNCMD），所以后面不需要处理 WM_COMMAND。
const (
	idOpenDsh uintptr = iota + 1
	idOpenAdmin
	idStart
	idStop
	idRestart
	idRestoreConcise
	idLog
	idAutostart
	idExit
)

type application struct {
	hwnd       syscall.Handle
	icon       syscall.Handle
	iconOwned  bool
	executable string
	root       string
	settings   settings
	log        *rotatingLog
	stack      *stack
	// 开机自启动拉起的这次运行不弹「已启动」通知：登录时的
	// 通知没有对应的用户动作，只会造成打扰。
	launchedByAutostart bool
	// 两条气球通知都每次运行最多显示一次：launcher 每次重启
	// 都会重新打印横幅，每次重启都通知只会造成打扰，而不是帮助。
	setupNoticeShown   atomic.Bool
	startedNoticeShown atomic.Bool
}

var (
	app *application
	// Explorer 重启时会发送此消息，每个托盘图标都必须重新添加；
	// 没有它，图标会在本次会话剩余时间里悄悄消失。
	taskbarCreatedMessage uint32
	// 在进程整个生命周期内保持存活：Windows 可能在
	// 注册函数返回很久之后才调用它。
	wndProcCallback = syscall.NewCallback(wndProc)
)

func stateLabel(state stackState) string {
	switch state {
	case stackStarting:
		return "正在启动"
	case stackRunning:
		return "运行中"
	case stackStopping:
		return "正在停止"
	default:
		return "已停止"
	}
}

func wndProc(hwnd syscall.Handle, message uint32, wParam uintptr, lParam uintptr) uintptr {
	switch message {
	case wmTrayCallback:
		// 版本 3 的打包方式：鼠标消息位于 lParam 的低字。
		switch uint32(lParam & 0xffff) {
		case wmRButtonUp, wmContextMenu:
			app.showMenu()
		case wmLButtonDblClk:
			app.openDsh()
		case ninBalloonUserClick:
			app.openDsh()
		}
		return 0
	case wmStateChanged:
		app.updateTooltip()
		return 0
	case wmSetupNotice:
		app.showSetupBalloon()
		return 0
	case wmStartedNotice:
		app.showStartedBalloon()
		return 0
	case wmClose:
		procDestroyWindow.Call(uintptr(hwnd))
		return 0
	case wmDestroy:
		procPostQuitMessage.Call(0)
		return 0
	}
	if taskbarCreatedMessage != 0 && message == taskbarCreatedMessage {
		app.addIcon()
		return 0
	}
	result, _, _ := procDefWindowProcW.Call(uintptr(hwnd), uintptr(message), wParam, lParam)
	return result
}

// createWindow 创建每个托盘图标都需要的隐藏窗口：Shell_NotifyIcon
// 将点击作为窗口消息发送，而 TrackPopupMenu 需要一个可以
// 置于前台的窗口，否则菜单将无法再次关闭。
func createWindow() (syscall.Handle, error) {
	instance, err := moduleHandle()
	if err != nil {
		return 0, err
	}
	className := utf16Ptr(windowClassName)
	class := wndClassEx{
		lpfnWndProc:   wndProcCallback,
		hInstance:     instance,
		lpszClassName: className,
	}
	class.cbSize = uint32(unsafe.Sizeof(class))
	atom, _, err := procRegisterClassExW.Call(uintptr(unsafe.Pointer(&class)))
	if atom == 0 {
		return 0, fmt.Errorf("RegisterClassExW 失败：%w", err)
	}
	hwnd, _, err := procCreateWindowExW.Call(
		0,
		uintptr(unsafe.Pointer(className)),
		uintptr(unsafe.Pointer(utf16Ptr(appName))),
		0, 0, 0, 0, 0, 0, 0,
		uintptr(instance),
		0,
	)
	if hwnd == 0 {
		return 0, fmt.Errorf("CreateWindowExW 失败：%w", err)
	}
	return syscall.Handle(hwnd), nil
}

// loadTrayIcon 从本可执行文件自己的资源中取出图标
// （packaging/win-launcher/rsrc_windows_amd64.syso，由
// packaging/make-icons.mjs 生成），失败时回退到系统默认应用图标：
// 如果程序完全没有图标，用户就失去唯一的操作入口。
//
// 请求的尺寸是 SM_CXSMICON，而不是 LR_DEFAULTSIZE 的 32x32；资源
// 包含 16/20/24/32/48/...，因此 LoadImage 会选择真实尺寸，而不是
// 把某个图标压扁。进程启用了按显示器 DPI 感知（见
// 同一资源文件中的清单），因此该指标已经按比例返回——150% 缩放时为 24。
func loadTrayIcon() (syscall.Handle, bool) {
	width, _, _ := procGetSystemMetrics.Call(smCXSmIcon)
	height, _, _ := procGetSystemMetrics.Call(smCYSmIcon)
	if instance, err := moduleHandle(); err == nil {
		handle, _, _ := procLoadImageW.Call(
			uintptr(instance),
			appIconResourceID,
			imageIcon,
			width,
			height,
			0,
		)
		if handle != 0 {
			return syscall.Handle(handle), true
		}
	}
	stock, _, _ := procLoadIconW.Call(0, idiApplication)
	return syscall.Handle(stock), false
}

func (a *application) baseIconData() notifyIconData {
	data := notifyIconData{
		hWnd:             a.hwnd,
		uID:              1,
		uCallbackMessage: wmTrayCallback,
		hIcon:            a.icon,
	}
	data.cbSize = uint32(unsafe.Sizeof(data))
	return data
}

func (a *application) tooltip() string {
	return fmt.Sprintf("dsh-remote（%s）— dsh 界面 %s", stateLabel(a.stack.currentState()), a.settings.dshWebURL())
}

func (a *application) addIcon() {
	data := a.baseIconData()
	data.uFlags = nifMessage | nifIcon | nifTip
	setUTF16(data.szTip[:], a.tooltip())
	procShellNotifyIconW.Call(uintptr(nimAdd), uintptr(unsafe.Pointer(&data)))
	// 请求版本 3 才能让气球通知点击以
	// NIN_BALLOONUSERCLICK 的形式返回，而不是被吞掉。
	version := a.baseIconData()
	version.uVersion = notifyIconVersion
	procShellNotifyIconW.Call(uintptr(nimSetVersion), uintptr(unsafe.Pointer(&version)))
}

func (a *application) removeIcon() {
	data := a.baseIconData()
	procShellNotifyIconW.Call(uintptr(nimDelete), uintptr(unsafe.Pointer(&data)))
	if a.iconOwned && a.icon != 0 {
		procDestroyIcon.Call(uintptr(a.icon))
	}
}

func (a *application) updateTooltip() {
	data := a.baseIconData()
	data.uFlags = nifTip
	setUTF16(data.szTip[:], a.tooltip())
	procShellNotifyIconW.Call(uintptr(nimModify), uintptr(unsafe.Pointer(&data)))
}

// showSetupBalloon 说明缺少什么并提供页面，但不会
// 打开页面（D6）；用户必须自行点击。
func (a *application) showSetupBalloon() {
	data := a.baseIconData()
	data.uFlags = nifInfo
	data.dwInfoFlags = niifInfo
	setUTF16(data.szInfoTitle[:], "dsh-remote 还没有设置完成")
	setUTF16(data.szInfo[:], "还没有管理员账号，管理界面暂时不能登录。点这条通知，在本机浏览器里完成设置。")
	procShellNotifyIconW.Call(uintptr(nimModify), uintptr(unsafe.Pointer(&data)))
}

// showStartedBalloon 回应双击之后的「好像没反应」：说明图标落在
// 哪里、怎么打开界面。新装机器上让位给设置通知——那一条更可
// 行动，而且只晚几毫秒。
func (a *application) showStartedBalloon() {
	if a.setupNoticeShown.Load() {
		return
	}
	data := a.baseIconData()
	data.uFlags = nifInfo
	data.dwInfoFlags = niifInfo
	setUTF16(data.szInfoTitle[:], "dsh-remote 已启动")
	setUTF16(data.szInfo[:], "图标在任务栏右下角的通知区域（可能折叠在「^」里）。点这条通知打开 dsh 界面；右键图标可停止或退出。")
	procShellNotifyIconW.Call(uintptr(nimModify), uintptr(unsafe.Pointer(&data)))
}

// onChildLine 运行在读取子进程输出的 goroutine 上，而所有
// shell 调用都必须属于拥有窗口的线程，因此这里只投递消息。
func (a *application) onChildLine(line string) {
	if strings.Contains(line, adminMissingMarker) {
		if a.setupNoticeShown.Swap(true) {
			return
		}
		procPostMessageW.Call(uintptr(a.hwnd), uintptr(wmSetupNotice), 0, 0)
		return
	}
	if a.launchedByAutostart {
		return
	}
	if strings.Contains(line, readyMarker) && !a.startedNoticeShown.Swap(true) {
		time.AfterFunc(startedNoticeDelay, func() {
			procPostMessageW.Call(uintptr(a.hwnd), uintptr(wmStartedNotice), 0, 0)
		})
	}
}

func (a *application) onStateChange() {
	procPostMessageW.Call(uintptr(a.hwnd), uintptr(wmStateChanged), 0, 0)
}

func appendItem(menu uintptr, id uintptr, label string, enabled bool) {
	flags := mfString
	if !enabled {
		flags |= mfGrayed
	}
	procAppendMenuW.Call(menu, flags, id, uintptr(unsafe.Pointer(utf16Ptr(label))))
}

func appendCheckItem(menu uintptr, id uintptr, label string, checked bool) {
	flags := mfString
	if checked {
		flags |= mfChecked
	}
	procAppendMenuW.Call(menu, flags, id, uintptr(unsafe.Pointer(utf16Ptr(label))))
}

func appendSeparator(menu uintptr) {
	procAppendMenuW.Call(menu, mfSeparator, 0, 0)
}

// showMenu 每次右键都从头构建菜单，因此展示的内容
// ——启动 / 停止 / 重启 中哪些可用、开机自启动是否开启——会在
// 绘制当时读取，而不是使用记忆的状态。
//
// 初始化、重置密码、重置 TOTP 刻意不提供：都需要文本输入，
// Win32 没有内置输入对话框，而 relay 已在
// 浏览器里提供这三项。打开管理界面即可进入。
func (a *application) showMenu() {
	menu, _, _ := procCreatePopupMenu.Call()
	if menu == 0 {
		return
	}
	defer procDestroyMenu.Call(menu)

	state := a.stack.currentState()
	appendItem(menu, idOpenDsh, "打开 dsh 界面", true)
	appendItem(menu, idOpenAdmin, "打开管理界面", true)
	appendSeparator(menu)
	appendItem(menu, idStart, "启动", state == stackStopped)
	appendItem(menu, idStop, "停止", state == stackRunning || state == stackStarting)
	appendItem(menu, idRestart, "重启", state == stackRunning)
	// 简洁模式被用户在 dsh 插件页停用后才出现：它是唯一的恢复入口
	//（停用后 dsh 的插件页不再列出该 Bundle）。菜单每次右键都重新
	// 读取 profile manifest，因此停用/补回后状态即时反映。
	if conciseModeDisabled(dshHomeDir(), a.settings.dshProfile) {
		appendItem(menu, idRestoreConcise, "补回简洁模式", true)
	}
	appendSeparator(menu)
	appendItem(menu, idLog, "查看日志", true)
	appendCheckItem(menu, idAutostart, "开机自启动", autostartEnabled())
	appendSeparator(menu)
	appendItem(menu, idExit, "退出", true)
	// 加粗；双击图标也执行此命令。
	procSetMenuDefaultItem.Call(menu, idOpenDsh, 0)

	// 没有这一点，点击其他位置后菜单仍会留在屏幕上：Windows
	// 只会关闭由前台窗口拥有的跟踪菜单。
	procSetForegroundWindow.Call(uintptr(a.hwnd))
	var cursor point
	procGetCursorPos.Call(uintptr(unsafe.Pointer(&cursor)))
	chosen, _, _ := procTrackPopupMenu.Call(
		menu,
		tpmLeftAlign|tpmBottomAlign|tpmRightButton|tpmReturnCmd|tpmNonNotify,
		uintptr(cursor.x),
		uintptr(cursor.y),
		0,
		uintptr(a.hwnd),
		0,
	)
	// 这是上面 SetForegroundWindow 的配套调用；它让菜单
	// 正确地自行销毁。
	procPostMessageW.Call(uintptr(a.hwnd), uintptr(wmNull), 0, 0)
	a.invoke(chosen)
}

// invoke 执行菜单命令。任何需要等待进程的操作都会交给
// goroutine：当前代码运行在消息循环中，循环阻塞会让图标冻结，
// 菜单也无法再次打开。
func (a *application) invoke(command uintptr) {
	switch command {
	case idOpenDsh:
		a.openDsh()
	case idOpenAdmin:
		a.openAdmin()
	case idStart:
		a.stack.start()
	case idStop:
		go a.stack.stop()
	case idRestart:
		go a.stack.restart()
	case idRestoreConcise:
		go a.restoreConciseMode()
	case idLog:
		a.openLog()
	case idAutostart:
		a.toggleAutostart()
	case idExit:
		go a.quit()
	}
}

func (a *application) openDsh() {
	a.open(a.settings.dshWebURL())
}

// restoreConciseMode 把简洁模式 Bundle 写回 dsh profile 并在 stack
// 运行中时重启使它生效。文件改写交给 launcher 的一次性命令完成
// （--restore-bundle），托盘不复制 profile manifest 的合并逻辑；
// 补回后该菜单项随下次右键自然消失。
func (a *application) restoreConciseMode() {
	a.log.printf("正在补回简洁模式（%s）", conciseModeBundle)
	output, err := a.stack.runOneShot([]string{"--restore-bundle=" + conciseModeBundle})
	for _, line := range strings.Split(strings.TrimRight(output, "\r\n"), "\n") {
		if line != "" {
			a.log.printf("[launcher] %s", strings.TrimPrefix(line, "[dsh-remote] "))
		}
	}
	if err != nil {
		a.log.printf("补回简洁模式失败：%v", err)
		messageBox(
			"补回简洁模式失败：\n\n"+err.Error()+"\n\n详情见日志：\n"+a.settings.logPath(),
			appName,
			mbIconError,
		)
		return
	}
	if a.stack.currentState() == stackRunning {
		a.log.printf("补回完成，正在重启 dsh-remote 使其生效")
		a.stack.restart()
		return
	}
	a.log.printf("补回完成；下次启动时生效")
}

func (a *application) openAdmin() {
	a.open(a.settings.adminURL())
}

// open 打开界面地址：优先本机 Chrome，找不到或启动不了
// 再交给用户配置的默认浏览器——用户要的是“尽量 Chrome”，
// 不是“非 Chrome 不可”。
func (a *application) open(target string) {
	if chrome := findChrome(); chrome != "" {
		err := shellOpenWith(chrome, target)
		if err == nil {
			a.log.printf("用 Chrome 打开 %s（%s）", target, chrome)
			return
		}
		a.log.printf("用 Chrome 打开 %s 失败（%v），改用默认浏览器", target, err)
	}
	if err := shellOpen(target); err != nil {
		a.log.printf("打开 %s 失败：%v", target, err)
		messageBox("打不开 "+target+"：\n\n"+err.Error(), appName, mbIconError)
	}
}

func (a *application) openLog() {
	path := a.settings.logPath()
	if err := shellOpen(path); err == nil {
		return
	}
	// 普通 Windows 没有为 .log 关联程序，“打开方式”对话框
	// 不如直接显示文件。
	if err := shellOpenWith("notepad.exe", path); err != nil {
		messageBox("打不开日志文件：\n\n"+path+"\n\n"+err.Error(), appName, mbIconError)
	}
}

func (a *application) toggleAutostart() {
	enabled := autostartEnabled()
	if err := setAutostart(a.executable, !enabled); err != nil {
		a.log.printf("修改开机自启动失败：%v", err)
		messageBox("改不了开机自启动：\n\n"+err.Error(), appName, mbIconError)
		return
	}
	if enabled {
		a.log.printf("已关闭开机自启动")
		return
	}
	a.log.printf("已开启开机自启动：%s", a.executable)
}

// quit 先停止子进程：dsh 仍在运行时图标不能消失，
// 否则用户将失去停止它的办法。
func (a *application) quit() {
	a.stack.stop()
	procPostMessageW.Call(uintptr(a.hwnd), uintptr(wmClose), 0, 0)
}

func runMessageLoop() {
	var message msg
	for {
		result, _, _ := procGetMessageW.Call(uintptr(unsafe.Pointer(&message)), 0, 0, 0)
		// 0 表示 WM_QUIT，-1 表示错误；两者都表示循环结束。
		if result == 0 || int32(result) == -1 {
			return
		}
		procTranslateMessage.Call(uintptr(unsafe.Pointer(&message)))
		procDispatchMessageW.Call(uintptr(unsafe.Pointer(&message)))
	}
}
