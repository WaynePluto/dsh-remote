package main

import (
	"os/exec"
	"path/filepath"
	"strconv"
	"sync"
	"syscall"
	"time"
)

type stackState int

const (
	stackStopped stackState = iota
	stackStarting
	stackRunning
	stackStopping
)

const (
	// 温和路径在改用作业对象前最多等待多久。
	//
	// 这是实测值而非猜测：Windows 10/11 中，无窗口进程的子进程收到控制台事件时，
	// 即使 GenerateConsoleCtrlEvent 返回 TRUE，事件也不会送达子进程——无论使用子进程自己的控制台、
	// 本进程分配并共享的控制台，还是有无处理器。因此实际停止依靠下方的兜底，等待太久只会让“停止”看起来失灵。
	//
	// 代价没有想象中大：Windows 上 launcher 对每个子进程执行
	// `taskkill /pid <child> /T /F`（packages/launcher/src/supervisor.ts），作业对象也会直接杀掉全部进程；
	// 失去的只是 connector → relay → dsh 顺序，relay 日志少几条重连错误而已。
	// 仍先尝试温和路径，因为这是正确的首选，而且只需一次调用。
	gracefulStopTimeout = 8 * time.Second
	forcedStopTimeout   = 10 * time.Second
	// 重启在启动下一次运行前等待上一次运行结束的最长时间；
	// 状态必须回到 stopped，start 才会被允许。
	restartSettleTimeout = 30 * time.Second
)

// stack 持有唯一的 `node dist/index.js` 子进程，而它又持有 dsh、
// relay 和 connector。
type stack struct {
	root  string
	node  string
	entry string
	// 用户传给 dsh-remote.exe、再交给 launcher 的额外参数。
	arguments []string
	log       *rotatingLog
	onLine    func(string)
	onState   func()

	mu            sync.Mutex
	state         stackState
	pid           int
	job           syscall.Handle
	done          chan struct{}
	stopRequested bool
}

func newStack(root string, node string, arguments []string, log *rotatingLog) *stack {
	return &stack{
		root:      root,
		node:      node,
		entry:     filepath.Join(root, "dist", "index.js"),
		arguments: arguments,
		log:       log,
	}
}

func (s *stack) currentState() stackState {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.state
}

func (s *stack) notify() {
	if s.onState != nil {
		s.onState()
	}
}

// start 启动 launcher，除非它已经运行或正在退出。
func (s *stack) start() {
	s.mu.Lock()
	if s.state != stackStopped {
		s.mu.Unlock()
		return
	}
	s.state = stackStarting
	s.stopRequested = false
	s.mu.Unlock()
	s.notify()
	go s.run()
}

func (s *stack) run() {
	s.log.printf("启动 %s %s", s.node, s.entry)
	// 每次运行使用一个作业对象：关闭它会杀掉 launcher 遗留的任何进程，
	// 新作业对象则不会混入上一次运行的残留进程。
	job, err := createKillOnCloseJob()
	if err != nil {
		s.log.printf("创建作业对象失败：%v；停止时改用 taskkill 兜底", err)
	}

	command := exec.Command(s.node, append([]string{s.entry}, s.arguments...)...)
	// launcher 会在工作目录查找 dsh-remote.config.json，而双击启动或通过开机自启动启动时使用的目录无法预测。
	command.Dir = s.root
	command.Stdout = &lineWatcher{sink: s.log, onLine: s.onLine}
	command.Stderr = &lineWatcher{sink: s.log, onLine: s.onLine}
	// 使用 CREATE_NO_WINDOW 而不是 DETACHED_PROCESS：子进程仍会获得自己的控制台，只是不可见；该控制台是无窗口进程请求其温和关闭的唯一方式。
	command.SysProcAttr = &syscall.SysProcAttr{CreationFlags: createNoWindow, HideWindow: true}

	if err := command.Start(); err != nil {
		s.log.printf("启动 Node 失败：%v", err)
		closeJob(job)
		s.finish()
		messageBox(
			"启动 dsh-remote 失败：\n\n"+err.Error()+"\n\n详情见日志：\n"+s.log.path,
			appName,
			mbIconError,
		)
		return
	}

	pid := command.Process.Pid
	if job != 0 {
		// 启动后立即分配，因此 launcher 在作业对象外生成进程的窗口只有几毫秒。Windows 不允许通过 os/exec 直接创建已属于作业对象的进程；
		// 挂起启动意味着重新实现这套机制。
		if err := assignProcessToJob(job, pid); err != nil {
			s.log.printf("把 Node（pid %d）放进作业对象失败：%v；停止时改用 taskkill 兜底", pid, err)
			closeJob(job)
			job = 0
		}
	}

	done := make(chan struct{})
	s.mu.Lock()
	s.state = stackRunning
	s.pid = pid
	s.job = job
	s.done = done
	stopWanted := s.stopRequested
	s.mu.Unlock()
	s.log.printf("Node 已启动，pid %d；日志文件 %s", pid, s.log.path)
	s.notify()

	if stopWanted {
		// 运行仍在生成进程时用户点击了“停止”。
		go s.stop()
	}

	err = command.Wait()
	if err == nil {
		s.log.printf("dsh-remote 已退出（退出码 0）")
	} else {
		s.log.printf("dsh-remote 已退出：%v", err)
	}

	s.mu.Lock()
	s.state = stackStopped
	s.pid = 0
	s.job = 0
	s.done = nil
	s.mu.Unlock()
	// 在状态变为 stopped 后再关闭，这样被此 channel 唤醒的调用者
	// 看到的 stack 就可以再次启动。
	closeJob(job)
	close(done)
	s.notify()
}

// finish 在启动未产生进程时重置状态。
func (s *stack) finish() {
	s.mu.Lock()
	s.state = stackStopped
	s.pid = 0
	s.job = 0
	s.done = nil
	s.mu.Unlock()
	s.notify()
}

// stop 先要求 launcher 像 Ctrl+C 一样关闭，失败时回退到
// 作业对象。
func (s *stack) stop() {
	s.mu.Lock()
	if s.state != stackRunning && s.state != stackStarting {
		s.mu.Unlock()
		return
	}
	if s.state == stackStarting {
		// 还没有可发送信号的进程；run() 一旦生成进程就会处理这个请求。
		s.stopRequested = true
		s.mu.Unlock()
		return
	}
	pid, job, done := s.pid, s.job, s.done
	s.state = stackStopping
	s.mu.Unlock()
	s.notify()

	s.log.printf("正在停止：先请 launcher 自己按 connector → relay → dsh 收尾")
	if !requestConsoleShutdown(pid) {
		s.log.printf("没能把 Ctrl+C 送到 pid %d", pid)
	} else if waitFor(done, gracefulStopTimeout) {
		return
	}
	s.log.printf("改用作业对象强制结束整棵进程树（dsh、控制台、连接器及其派生的 shell）")

	if job != 0 {
		terminateJob(job)
	} else {
		killTree(pid)
	}
	if !waitFor(done, forcedStopTimeout) {
		s.log.printf("强制结束后 Node 仍未回收，pid %d", pid)
	}
}

// restart() 重启整个 stack。
func (s *stack) restart() {
	s.stop()
	deadline := time.Now().Add(restartSettleTimeout)
	for s.currentState() != stackStopped {
		if time.Now().After(deadline) {
			s.log.printf("重启失败：上一次运行没有结束")
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	s.start()
}

func closeJob(job syscall.Handle) {
	if job == 0 {
		return
	}
	syscall.CloseHandle(job)
}

// killTree 用于无法创建作业对象的罕见情况，是最后的兜底。
// 单独调用 child.kill() 会留下 dsh 生成的 shell，使其继续占用
// 端口（见 packages/launcher/src/supervisor.ts）。
func killTree(pid int) {
	command := exec.Command("taskkill", "/pid", strconv.Itoa(pid), "/T", "/F")
	command.SysProcAttr = &syscall.SysProcAttr{CreationFlags: createNoWindow, HideWindow: true}
	command.Run()
}

func waitFor(done <-chan struct{}, timeout time.Duration) bool {
	if done == nil {
		return true
	}
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case <-done:
		return true
	case <-timer.C:
		return false
	}
}
