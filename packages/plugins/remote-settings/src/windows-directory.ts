import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

type SpawnProcess = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess
interface WindowsDirectoryInternals {
  readonly spawn?: SpawnProcess
  readonly focus?: (directory: string) => void
}

function powershellExecutable(): string {
  return join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

/** 固定脚本只插入 base64 路径，避免目录内容进入 PowerShell 语法。 */
function focusCommand(directory: string): string {
  const pathBase64 = Buffer.from(directory, 'utf8').toString('base64')
  const script = String.raw`
$target = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${pathBase64}'))
$target = [IO.Path]::GetFullPath($target).TrimEnd([char]92)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class DshRemoteForeground {
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int command);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr processId);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint source, uint target, bool attach);
}
'@
$shell = New-Object -ComObject Shell.Application
$deadline = [DateTime]::UtcNow.AddSeconds(5)
$window = $null
do {
  $window = @($shell.Windows()) | Where-Object {
    try {
      $_.Visible -and ([IO.Path]::GetFullPath(([Uri]$_.LocationURL).LocalPath).TrimEnd([char]92) -ieq $target)
    } catch { $false }
  } | Select-Object -Last 1
  if ($null -eq $window) { Start-Sleep -Milliseconds 50 }
} while ($null -eq $window -and [DateTime]::UtcNow -lt $deadline)
if ($null -eq $window) { exit 0 }
$handle = [IntPtr][long]$window.HWND
$currentThread = [DshRemoteForeground]::GetCurrentThreadId()
$foregroundThread = [DshRemoteForeground]::GetWindowThreadProcessId([DshRemoteForeground]::GetForegroundWindow(), [IntPtr]::Zero)
$targetThread = [DshRemoteForeground]::GetWindowThreadProcessId($handle, [IntPtr]::Zero)
$foregroundAttached = $false
$targetAttached = $false
try {
  if ($foregroundThread -ne 0 -and $foregroundThread -ne $currentThread) {
    $foregroundAttached = [DshRemoteForeground]::AttachThreadInput($currentThread, $foregroundThread, $true)
  }
  if ($targetThread -ne 0 -and $targetThread -ne $currentThread) {
    $targetAttached = [DshRemoteForeground]::AttachThreadInput($currentThread, $targetThread, $true)
  }
  [void][DshRemoteForeground]::ShowWindowAsync($handle, 9)
  [void][DshRemoteForeground]::BringWindowToTop($handle)
  [void][DshRemoteForeground]::SetForegroundWindow($handle)
} finally {
  if ($targetAttached) { [void][DshRemoteForeground]::AttachThreadInput($currentThread, $targetThread, $false) }
  if ($foregroundAttached) { [void][DshRemoteForeground]::AttachThreadInput($currentThread, $foregroundThread, $false) }
}
`
  return Buffer.from(script, 'utf16le').toString('base64')
}

/** 异步尝试激活目标 Explorer；任何 helper 失败都不改变“目录已打开”的结果。 */
export function focusWindowsDirectory(directory: string, spawnProcess: SpawnProcess = spawn): void {
  try {
    const helper = spawnProcess(powershellExecutable(), [
      '-NoProfile', '-NonInteractive', '-EncodedCommand', focusCommand(directory),
    ], { detached: true, stdio: 'ignore', windowsHide: true, shell: false })
    helper.once('error', () => {})
    helper.once('spawn', () => { helper.unref() })
  } catch {
    // 置前只是 best-effort，Explorer 本身已经成功创建。
  }
}

/** 启动可见 Explorer；进程创建即完成，Windows Shell 的后续交接不阻塞 RPC。 */
export function openWindowsDirectory(
  directory: string, signal: AbortSignal, internals: WindowsDirectoryInternals = {},
): Promise<void> {
  signal.throwIfAborted()
  const target = pathToFileURL(directory, { windows: true }).href.replaceAll(',', '%2C')
  const executable = join(process.env.SystemRoot ?? 'C:\\Windows', 'explorer.exe')
  const spawnProcess = internals.spawn ?? spawn
  const focus = internals.focus ?? (path => { focusWindowsDirectory(path) })
  return new Promise((resolve, reject) => {
    let child: ChildProcess
    try {
      child = spawnProcess(executable, [target], {
        detached: true, stdio: 'ignore', windowsHide: false, shell: false,
      })
    } catch (error) {
      reject(error)
      return
    }
    let settled = false
    const cleanup = (): void => {
      signal.removeEventListener('abort', abort)
      child.off('spawn', started)
      child.off('error', failed)
    }
    const started = (): void => {
      if (settled) return
      settled = true
      cleanup()
      child.unref()
      try { focus(directory) } catch {
        // 置前失败不能把已经成功创建的 Explorer 改判为失败。
      }
      resolve()
    }
    const failed = (error: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    const abort = (): void => {
      if (settled) return
      settled = true
      cleanup()
      child.kill()
      reject(signal.reason)
    }
    child.once('spawn', started)
    child.once('error', failed)
    signal.addEventListener('abort', abort, { once: true })
  })
}
