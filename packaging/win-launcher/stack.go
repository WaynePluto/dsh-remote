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
	// How long the polite path gets before the job object is used.
	//
	// Measured, not guessed: on Windows 10/11 a console control event sent to a
	// child of a windowless process is accepted by the console
	// (GenerateConsoleCtrlEvent returns TRUE) and never delivered to the child —
	// with the child's own console, with a console this process allocates and
	// shares, handler or no handler. So in practice the fallback below is what
	// stops the stack, and a long wait would only make 停止 feel broken.
	//
	// That costs less than it sounds: on Windows the launcher's own shutdown is
	// `taskkill /pid <child> /T /F` per child (packages/launcher/src/
	// supervisor.ts), so the job object reaches the same end state — every
	// process killed outright. What is lost is the connector → relay → dsh
	// ordering, which saves the relay a few reconnect errors in its log and
	// nothing else. The attempt stays because it is the correct thing to ask
	// for first, and because it costs one call.
	gracefulStopTimeout = 8 * time.Second
	forcedStopTimeout   = 10 * time.Second
	// How long 重启 waits for the previous run to be gone before starting the
	// next one; the state has to be back at stopped for start to be allowed.
	restartSettleTimeout = 30 * time.Second
)

// stack owns the one `node dist/index.js` child, which in turn owns dsh, the
// relay and the connector.
type stack struct {
	root  string
	node  string
	entry string
	// Extra arguments the user passed to dsh-remote.exe, handed to the launcher.
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

// start spawns the launcher unless one is already running or on its way out.
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
	// One job per run: closing it is what kills whatever the launcher left
	// behind, and a fresh job keeps a previous run's stragglers out of it.
	job, err := createKillOnCloseJob()
	if err != nil {
		s.log.printf("创建作业对象失败：%v；停止时改用 taskkill 兜底", err)
	}

	command := exec.Command(s.node, append([]string{s.entry}, s.arguments...)...)
	// The launcher looks for dsh-remote.config.json in the working directory, and
	// which directory a double-click (or an autostart entry) starts from is
	// unpredictable.
	command.Dir = s.root
	command.Stdout = &lineWatcher{sink: s.log, onLine: s.onLine}
	command.Stderr = &lineWatcher{sink: s.log, onLine: s.onLine}
	// CREATE_NO_WINDOW, not DETACHED_PROCESS: the child still gets a console of
	// its own, just an invisible one, and that console is the only way this
	// windowless process can ever ask it to shut down politely.
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
		// Assigned right after start, so the window in which the launcher could
		// spawn something outside the job is a few milliseconds wide. Windows
		// offers no way to create a process already inside a job through
		// os/exec, and a suspended start would mean reimplementing it.
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
		// 停止 was clicked while this run was still spawning.
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
	// Closed after the state is stopped so that anyone woken by this channel
	// sees a stack it is allowed to start again.
	closeJob(job)
	close(done)
	s.notify()
}

// finish resets the state after a start that never produced a process.
func (s *stack) finish() {
	s.mu.Lock()
	s.state = stackStopped
	s.pid = 0
	s.job = 0
	s.done = nil
	s.mu.Unlock()
	s.notify()
}

// stop asks the launcher to shut down the way Ctrl+C does, and falls back to
// the job object when it does not.
func (s *stack) stop() {
	s.mu.Lock()
	if s.state != stackRunning && s.state != stackStarting {
		s.mu.Unlock()
		return
	}
	if s.state == stackStarting {
		// No process to signal yet; run() picks this up as soon as there is one.
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

// killTree is the fallback for the rare case where no job object could be
// created. child.kill() alone would leave the shells dsh spawns holding its
// port (see packages/launcher/src/supervisor.ts).
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
