import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import { focusWindowsDirectory, openWindowsDirectory } from '../src/windows-directory.js'

function child() {
  const process = new EventEmitter() as ChildProcess
  process.unref = vi.fn(() => process)
  process.kill = vi.fn(() => true)
  return process
}

describe('Windows 可见目录打开', () => {
  it('直接启动分离的 GUI Explorer，进程创建后立即返回并异步置前', async () => {
    const spawned = child()
    const spawn = vi.fn(() => spawned)
    const focus = vi.fn()
    const signal = new AbortController().signal
    const directory = "C:\\Users\\A B,中\\preset's"
    const opening = openWindowsDirectory(directory, signal, { spawn, focus })
    expect(spawn).toHaveBeenCalledWith(join(process.env.SystemRoot ?? 'C:\\Windows', 'explorer.exe'),
      ["file:///C:/Users/A%20B%2C%E4%B8%AD/preset's"],
      { detached: true, stdio: 'ignore', windowsHide: false, shell: false })
    expect(spawned.unref).not.toHaveBeenCalled()
    expect(focus).not.toHaveBeenCalled()
    spawned.emit('spawn')
    await expect(opening).resolves.toBeUndefined()
    expect(spawned.unref).toHaveBeenCalledOnce()
    expect(focus).toHaveBeenCalledWith(directory)
  })

  it('spawn 后不等待 Explorer 退出或置前 helper 完成', async () => {
    const spawned = child()
    const focus = vi.fn()
    const opening = openWindowsDirectory('C:\\test', new AbortController().signal, {
      spawn: () => spawned,
      focus,
    })
    spawned.emit('spawn')
    await expect(opening).resolves.toBeUndefined()
    spawned.emit('exit', 1)
    expect(focus).toHaveBeenCalledOnce()
  })

  it('同步启动错误和 spawn 前 error 都会失败', async () => {
    const sync = new Error('sync failed')
    await expect(openWindowsDirectory('C:\\test', new AbortController().signal, {
      spawn: () => { throw sync },
    })).rejects.toBe(sync)
    const spawned = child()
    const opening = openWindowsDirectory('C:\\test', new AbortController().signal, { spawn: () => spawned })
    const async = new Error('spawn failed')
    spawned.emit('error', async)
    await expect(opening).rejects.toBe(async)
    expect(spawned.unref).not.toHaveBeenCalled()
  })

  it('已取消不启动，spawn 前取消会结束子进程', async () => {
    const aborted = AbortSignal.abort(new Error('cancelled'))
    const spawn = vi.fn(() => child())
    expect(() => openWindowsDirectory('C:\\test', aborted, { spawn })).toThrow('cancelled')
    expect(spawn).not.toHaveBeenCalled()

    const controller = new AbortController()
    const spawned = child()
    const opening = openWindowsDirectory('C:\\test', controller.signal, { spawn: () => spawned })
    controller.abort(new Error('request closed'))
    await expect(opening).rejects.toThrow('request closed')
    expect(spawned.kill).toHaveBeenCalledOnce()
    expect(spawned.unref).not.toHaveBeenCalled()
  })

  it('置前 helper 使用隐藏 PowerShell 固定脚本和 base64 路径', () => {
    const helper = child()
    const spawn = vi.fn((_command: string, _args: readonly string[], _options: SpawnOptions) => helper)
    const directory = "C:\\Users\\A B,中\\preset's"
    focusWindowsDirectory(directory, spawn)
    const [command, args, options] = spawn.mock.calls[0]!
    expect(command).toBe(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'))
    expect(args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-EncodedCommand'])
    expect(options).toEqual({ detached: true, stdio: 'ignore', windowsHide: true, shell: false })
    const script = Buffer.from(args[3]!, 'base64').toString('utf16le')
    expect(script).not.toContain(directory)
    expect(script).toContain(Buffer.from(directory, 'utf8').toString('base64'))
    expect(script).toContain('SetForegroundWindow')
    expect(script).toContain('AttachThreadInput')
    expect(script).toContain('LocationURL')
    helper.emit('spawn')
    expect(helper.unref).toHaveBeenCalledOnce()
  })

  it('置前 helper 的同步或异步失败不影响已打开 Explorer', async () => {
    expect(() => { focusWindowsDirectory('C:\\test', () => { throw new Error('helper failed') }) }).not.toThrow()
    const helper = child()
    focusWindowsDirectory('C:\\test', () => helper)
    expect(() => { helper.emit('error', new Error('helper failed')) }).not.toThrow()

    const spawned = child()
    const opening = openWindowsDirectory('C:\\test', new AbortController().signal, {
      spawn: () => spawned,
      focus: () => { throw new Error('focus failed') },
    })
    spawned.emit('spawn')
    await expect(opening).resolves.toBeUndefined()
  })
})
