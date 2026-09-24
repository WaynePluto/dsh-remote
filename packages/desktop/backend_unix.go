//go:build !windows

package main

import (
	"os"
	"os/exec"
	"syscall"
)

// adoptBackendProcess 在非 Windows 平台没有 Job Object 兜底；
// launcher 收到 SIGTERM/SIGKILL 前会先经 stdin 的优雅停止路径，
// 孤儿进程的完全回收留给 S10 平台适配验证。
func adoptBackendProcess(*os.Process) error {
	return nil
}

// spawnShellReplacement 在非 Windows 平台直接拉起新壳（无 Job 语义）。
func spawnShellReplacement(executable string) error {
	return exec.Command(executable).Start()
}

// killBackendTree 结束 launcher 进程；launcher 自己的信号处理会按
// connector → relay → dsh 的顺序回收子进程。
func killBackendTree(command *exec.Cmd) error {
	if command.Process == nil {
		return nil
	}
	return command.Process.Signal(syscall.SIGKILL)
}
