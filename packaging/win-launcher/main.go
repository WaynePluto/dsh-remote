// dsh-remote.exe —— Windows 上的双击入口，常驻通知区域。
//
// Windows will not run a double-clicked .ps1 (it opens an editor, and a
// downloaded file is blocked by the execution policy), and PowerShell 7 is not
// preinstalled, so start.ps1 alone would force a second prerequisite on top of
// Node. This executable removes both problems and adds one more thing: it keeps
// the stack under an icon in the notification area instead of under a console
// window nobody may close.
//
// It stays thin on purpose. All product logic, including the Node *version*
// check, lives in the launcher, which reports it in far more detail than this
// program ever should. The one thing the launcher cannot report is "there is no
// node at all" — it could not start — so that is the only check made here.
//
// Built with -H windowsgui (see scripts/pack.mjs), so there is no console and
// nothing can be printed: everything the launcher says goes to the log file,
// and everything this program says goes into a message box or a balloon.
//
// Windows-only by construction (it calls user32/shell32/kernel32 directly);
// scripts/pack.mjs always builds it with GOOS=windows.
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
	appName         = "dsh-remote"
	nodeDownloadURL = "https://nodejs.org"
	// Only quoted in the "no Node" message; the real gate is
	// packages/launcher/src/node-version.ts.
	minimumNodeVersion = "22.19.0"

	// Session-scoped, so two different users on one machine are not blocked from
	// each having their own stack; two copies in one session would collide on
	// the same ports, which is what this guards against.
	singleInstanceMutexName = `Local\dsh-remote-tray-single-instance`

	// scripts/pack.mjs runs this before writing the zip. A windowsgui binary
	// cannot be smoke-tested by watching console output, so it gets a mode that
	// checks the exe -> node -> dist chain and reports through the exit code,
	// writing its detail to stderr (a pipe works, a console is not needed).
	selfCheckFlag = "--selfcheck"
)

func main() {
	if len(os.Args) > 1 && os.Args[1] == selfCheckFlag {
		os.Exit(runSelfCheck())
	}
	os.Exit(runTray())
}

func runTray() int {
	// The window, its message loop and every menu it opens must stay on one
	// thread; Windows ties window ownership to the thread that created it.
	runtime.LockOSThread()

	mutex, alreadyRunning, err := acquireSingleInstance(singleInstanceMutexName)
	if err != nil {
		messageBox("无法判断 dsh-remote 是不是已经在运行了："+err.Error(), appName, mbIconError)
		return 1
	}
	defer syscall.CloseHandle(mutex)
	if alreadyRunning {
		messageBox(
			"dsh-remote 已经在运行了。\n\n"+
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
		executable = filepath.Join(root, "dsh-remote.exe")
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
				"dsh-remote 使用你本机的 Node.js 运行，请到 "+nodeDownloadURL+"\n"+
				"下载安装 LTS 版（"+minimumNodeVersion+" 或更高），装好后重新运行本程序。",
			appName,
			mbIconError,
		)
		return 1
	}

	resolved := loadSettings(root, os.Args[1:])
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
	log.printf("dsh-remote 托盘启动，程序 %s", executable)
	if resolved.path == "" {
		log.printf("没有找到配置文件，按默认值推断地址：控制台 %s，dsh %s", resolved.consoleURL(), resolved.dshURL())
	} else {
		log.printf("已读取配置 %s：控制台 %s，dsh %s", resolved.path, resolved.consoleURL(), resolved.dshURL())
	}

	app = &application{executable: executable, root: root, settings: resolved, log: log}
	app.stack = newStack(root, node, os.Args[1:], log)
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

	// The loop only ends after 退出, which has already stopped the children;
	// stopping again is a no-op and covers a WM_QUIT from anywhere else.
	app.stack.stop()
	app.removeIcon()
	log.printf("dsh-remote 托盘已退出")
	return 0
}

// runSelfCheck verifies everything the tray needs before it would ever show an
// icon: the package root, dist/index.js next to it, and a node on PATH. It
// answers through the exit code and writes the detail to stdout/stderr, which
// work when redirected even without a console. No window is created and nothing
// is started, so scripts/pack.mjs can run it unattended.
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
	fmt.Fprintf(os.Stdout, "root=%s\nnode=%s\nentry=%s\nlog=%s\nconsole=%s\ndsh=%s\n",
		root, node, entry, resolved.logPath(), resolved.consoleURL(), resolved.dshURL())
	return 0
}

// packageRoot returns the directory holding this executable, with symlinks
// resolved so a symlinked dsh-remote.exe still finds the real dist/ next to it.
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
