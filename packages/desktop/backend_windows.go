//go:build windows

package main

import (
	"fmt"
	"log"
	"os"
	"os/exec"
	"syscall"
	"unsafe"
)

var (
	backendKernel32                 = syscall.NewLazyDLL("kernel32.dll")
	backendCreateJobObject          = backendKernel32.NewProc("CreateJobObjectW")
	backendSetInformationJobObject  = backendKernel32.NewProc("SetInformationJobObject")
	backendAssignProcessToJobObject = backendKernel32.NewProc("AssignProcessToJobObject")
	backendOpenProcess              = backendKernel32.NewProc("OpenProcess")
)

const backendJobObjectExtendedInformation = 9
const backendJobObjectLimitKillOnJobClose = 0x2000

// backendDesktopShellJob 持有后台进程树的 Job Object；桌面壳退出（含崩溃）
// 时内核关闭句柄，KILL_ON_JOB_CLOSE 兜底回收整棵树，孤儿后台不会占住端口。
var backendDesktopShellJob uintptr

// adoptBackendProcess 把后台根进程挂进 Job Object；launcher 尚未 spawn 子进程，
// 立即挂载即可覆盖整棵树（Job 具有继承性）。
func adoptBackendProcess(process *os.Process) error {
	if backendDesktopShellJob == 0 {
		job, _, callErr := backendCreateJobObject.Call(0, 0)
		if job == 0 {
			return fmt.Errorf("CreateJobObjectW: %v", callErr)
		}
		type ioCounter struct{ _ [6]uint64 }
		type jobObjectBasicLimitInformation struct {
			PerProcessUserTimeLimit int64
			PerJobUserTimeLimit     int64
			LimitFlags              uint32
			MinimumWorkingSetSize   uintptr
			MaximumWorkingSetSize   uintptr
			ActiveProcessLimit      uint32
			Affinity                uintptr
			PriorityClass           uint32
			SchedulingClass         uint32
		}
		type jobObjectExtendedLimitInformation struct {
			BasicLimitInformation jobObjectBasicLimitInformation
			IoInfo                ioCounter
			ProcessMemoryLimit    uintptr
			JobMemoryLimit        uintptr
			PeakProcessMemoryUsed uintptr
			PeakJobMemoryUsed     uintptr
		}
		var limits jobObjectExtendedLimitInformation
		// BREAKAWAY_OK 允许壳自重启时以 CREATE_BREAKAWAY_FROM_JOB 拉起新壳；
		// 否则新壳会继承本 Job，旧壳退出（Job 最后一个句柄关闭）会把新壳一起杀掉。
		limits.BasicLimitInformation.LimitFlags = backendJobObjectLimitKillOnJobClose | 0x00000800
		if ok, _, callErr := backendSetInformationJobObject.Call(
			job, backendJobObjectExtendedInformation,
			uintptr(unsafe.Pointer(&limits)), unsafe.Sizeof(limits),
		); ok == 0 {
			return fmt.Errorf("SetInformationJobObject: %v", callErr)
		}
		backendDesktopShellJob = job
	}
	// Go 1.25 的 os.Process 不再导出句柄访问；按 pid 打开即可，
	// 权限需要 PROCESS_SET_QUOTA | PROCESS_TERMINATE（Job 挂载的最小集合）。
	const processSetQuota = 0x0100
	const processTerminate = 0x0001
	handle, _, callErr := backendOpenProcess.Call(processSetQuota|processTerminate, 0, uintptr(process.Pid))
	if handle == 0 {
		return fmt.Errorf("OpenProcess(pid=%d): %v", process.Pid, callErr)
	}
	defer func() { _ = syscall.CloseHandle(syscall.Handle(handle)) }()
	ok2, _, assignErr := backendAssignProcessToJobObject.Call(
		backendDesktopShellJob, handle,
	)
	if ok2 == 0 {
		return fmt.Errorf("AssignProcessToJobObject: %v", assignErr)
	}
	return nil
}

// applyChildWindowPolicy：GUI 壳（-H=windowsgui）本身没有控制台；直接
// spawn console 子进程时 Windows 会为它新建可见终端窗口——双击启动的
// 用户先看到黑窗、后台跑完才看到主窗口。HideWindow 让新控制台隐藏创建。
func applyChildWindowPolicy(command *exec.Cmd) {
	command.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
}

// spawnShellReplacement 以脱离当前 Job 的方式拉起新壳：旧壳退出时
// KILL_ON_JOB_CLOSE 只回收旧的后台进程树，不影响新壳。
func spawnShellReplacement(executable string) error {
	command := exec.Command(executable)
	command.SysProcAttr = &syscall.SysProcAttr{
		CreationFlags: 0x01000000 | 0x00000008 | 0x00000200, // CREATE_BREAKAWAY_FROM_JOB | DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
		HideWindow:    true,
	}
	return command.Start()
}

// killBackendTree 用 taskkill /T /F 结束整棵进程树；这是 Windows 上唯一
// 能保证连同 shell 子进程一起退出的手段（supervisor 同款）。
func killBackendTree(command *exec.Cmd) error {
	if command.Process == nil {
		return nil
	}
	kill := exec.Command("taskkill", "/pid", fmt.Sprint(command.Process.Pid), "/T", "/F")
	kill.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	if err := kill.Run(); err != nil {
		log.Printf("taskkill 兜底失败：%v", err)
		_ = command.Process.Kill()
		return err
	}
	return nil
}
