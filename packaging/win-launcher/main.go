// dsh-station.exe —— Windows 上的双击入口，常驻通知区域。
//
// Windows 双击不会执行 .ps1（会打开编辑器，下载文件还受执行策略拦截），PowerShell 7 也非预装；
// 因此 start.ps1 会给 Node 增加前置条件，本程序把 stack 放到通知区域而非易关闭的控制台。
// 产品逻辑（含 Node 版本检查）在 launcher，只有“完全没有 node”因 launcher 无法启动而由此检查。
//
// scripts/pack.mjs 用 -H windowsgui 构建，无控制台：launcher 输出入日志，本程序输出到消息框/气球通知。
// 仅支持 Windows（直接调用 user32/shell32/kernel32），scripts/pack.mjs 始终用 GOOS=windows 构建。
package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"syscall"
)

const (
	appName         = "dsh-station"
	nodeDownloadURL = "https://nodejs.org"
	// 只用于“没有 Node”消息；真正的检查项是
	// 版本常量路径：packages/launcher/src/node-version.ts。
	minimumNodeVersion = "22.19.0"

	// 按会话隔离，因此同一台机器上的不同用户不会互相阻止
	// 各自运行自己的 stack；同一会话中的两个副本会争用
	// 相同端口，这就是它要防止的情况。
	singleInstanceMutexName = `Local\dsh-station-tray-single-instance`

	// scripts/pack.mjs 写入 zip 前会运行此模式。windowsgui 二进制文件
	// 不能通过观察控制台输出做冒烟测试，因此该模式会
	// 检查 exe -> node -> dist 链路，并通过退出码报告结果，
	// 详情写入 stderr（管道可用，不需要控制台）。
	selfCheckFlag = "--selfcheck"
)

func main() {
	if len(os.Args) > 1 && os.Args[1] == selfCheckFlag {
		os.Exit(runSelfCheck())
	}
	os.Exit(runTray())
}

func runTray() int {
	// 窗口、消息循环及其打开的所有菜单都必须留在同一个
	// 线程上；Windows 将窗口所有权绑定到创建它的线程。
	runtime.LockOSThread()

	mutex, alreadyRunning, err := acquireSingleInstance(singleInstanceMutexName)
	if err != nil {
		messageBox("无法判断 dsh-station 是不是已经在运行了："+err.Error(), appName, mbIconError)
		return 1
	}
	defer syscall.CloseHandle(mutex)
	if alreadyRunning {
		messageBox(
			"dsh-station 已经在运行了。\n\n"+
				"看一眼任务栏右下角的通知区域（可能被折叠在「^」里），\n"+
				"右键它的图标就能打开控制台、停止或退出。",
			appName,
			mbIconInformation,
		)
		return 0
	}

	root, err := packageRoot()
	if err != nil {
		messageBox("认不出本程序所在的目录，因此不知道该从哪里启动：\n\n"+err.Error(), appName, mbIconError)
		return 1
	}
	executable, err := os.Executable()
	if err != nil {
		executable = filepath.Join(root, "dsh-station.exe")
	}

	entry := filepath.Join(root, "dist", "index.js")
	if _, err := os.Stat(entry); err != nil {
		messageBox(
			"找不到 "+entry+"。\n\n"+
				"这个压缩包没有完整解压，请把整个 zip 重新解压一次\n"+
				"（不要只解压其中几个文件，也不要在压缩软件的预览窗口里运行）。",
			appName,
			mbIconError,
		)
		return 1
	}

	node, err := exec.LookPath("node")
	if err != nil {
		messageBox(
			"没有找到 Node.js（命令 node 不存在）。\n\n"+
				"dsh-station 使用你本机的 Node.js 运行，请到 "+nodeDownloadURL+"\n"+
				"下载安装 LTS 版（"+minimumNodeVersion+" 或更高），装好后重新运行本程序。",
			appName,
			mbIconError,
		)
		return 1
	}

	// --autostart 只属于本程序（自启动条目用它标记登录拉起），
	// launcher 不认识这个参数，转发前必须去掉。
	launcherArguments, launchedByAutostart := splitArguments(os.Args[1:])

	resolved := loadSettings(root, launcherArguments)
	log, err := openLog(resolved.logPath())
	if err != nil {
		messageBox(
			"写不了日志文件 "+resolved.logPath()+"：\n\n"+err.Error()+"\n\n"+
				"托盘模式没有控制台，日志是唯一能看到运行情况的地方，所以这里不继续了。\n"+
				"想在终端里直接看输出，可以改用同目录下的 start.ps1。",
			appName,
			mbIconError,
		)
		return 1
	}
	defer log.close()
	log.printf("dsh-station 托盘启动，程序 %s", executable)
	if resolved.path == "" {
		log.printf("没有找到配置文件，按默认值推断地址：dsh 界面 %s，管理界面 %s", resolved.dshWebURL(), resolved.adminURL())
	} else {
		log.printf("已读取配置 %s：dsh 界面 %s，管理界面 %s", resolved.path, resolved.dshWebURL(), resolved.adminURL())
	}
	upgradeAutostartEntry(executable, log)

	app = &application{
		executable:          executable,
		root:                root,
		settings:            resolved,
		log:                 log,
		launchedByAutostart: launchedByAutostart,
	}
	app.stack = newStack(root, node, launcherArguments, log)
	app.stack.onLine = app.onChildLine
	app.stack.onState = app.onStateChange

	hwnd, err := createWindow()
	if err != nil {
		log.printf("创建托盘窗口失败：%v", err)
		messageBox("创建托盘窗口失败：\n\n"+err.Error(), appName, mbIconError)
		return 1
	}
	app.hwnd = hwnd
	app.icon, app.iconOwned = loadTrayIcon()
	if !app.iconOwned {
		log.printf("从自身资源里加载不到图标，改用系统默认图标")
	}
	taskbarCreatedMessage = registerTaskbarCreatedMessage()
	app.addIcon()

	app.stack.start()
	runMessageLoop()

	// 循环只会在“退出”之后结束；此时子进程已经停止，
	// 再次停止是空操作，也能覆盖来自其他位置的 WM_QUIT。
	app.stack.stop()
	app.removeIcon()
	log.printf("dsh-station 托盘已退出")
	return 0
}

// splitArguments 分离只属于本程序的参数；目前只有 --autostart。
// 其余参数原样转交给 launcher。
func splitArguments(arguments []string) (rest []string, autostart bool) {
	remaining := make([]string, 0, len(arguments))
	for _, argument := range arguments {
		if argument == autostartFlag {
			autostart = true
			continue
		}
		remaining = append(remaining, argument)
	}
	return remaining, autostart
}

// runSelfCheck 在托盘显示图标前验证它所需的一切：
// 软件包根目录、旁边的 dist/index.js，以及 PATH 中的 node。它
// 通过退出码回答，并将详情写入 stdout/stderr；重定向后即使没有控制台
// 也能正常工作。不创建窗口，也不启动任何内容，
// 因此 scripts/pack.mjs 可以无人值守地运行它。
func runSelfCheck() int {
	root, err := packageRoot()
	if err != nil {
		fmt.Fprintln(os.Stderr, "认不出本程序所在的目录："+err.Error())
		return 1
	}
	entry := filepath.Join(root, "dist", "index.js")
	if _, err := os.Stat(entry); err != nil {
		fmt.Fprintln(os.Stderr, "找不到 "+entry+"："+err.Error())
		return 1
	}
	node, err := exec.LookPath("node")
	if err != nil {
		fmt.Fprintln(os.Stderr, "没有找到 Node.js（命令 node 不存在）")
		return 1
	}
	resolved := loadSettings(root, nil)
	fmt.Fprintf(os.Stdout, "root=%s\nnode=%s\nentry=%s\nlog=%s\ndsh=%s\nadmin=%s\n",
		root, node, entry, resolved.logPath(), resolved.dshWebURL(), resolved.adminURL())
	return 0
}

// packageRoot 返回保存本可执行文件的目录，并解析符号链接，
// 这样通过符号链接启动的 dsh-station.exe 仍能找到旁边真实的 dist/。
func packageRoot() (string, error) {
	self, err := os.Executable()
	if err != nil {
		return "", err
	}
	resolved, err := filepath.EvalSymlinks(self)
	if err != nil {
		return "", err
	}
	return filepath.Dir(resolved), nil
}
