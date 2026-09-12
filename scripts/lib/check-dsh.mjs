import { spawn } from 'node:child_process'

/**
 * 结束 dsh 及其子进程，并等待退出或超时。
 * Windows 使用 taskkill 递归结束进程树，其他平台发送 SIGTERM；结束后销毁输出流。
 */
export async function stopDsh(child, { timeoutMs = 5_000 } = {}) {
  if (child === undefined || child === null) return
  const exited = child.exitCode !== null || child.signalCode !== null
  if (!exited) {
    if (process.platform === 'win32') {
      await new Promise((resolve) => {
        let finished = false
        const finish = () => {
          if (finished) return
          finished = true
          clearTimeout(timer)
          resolve()
        }
        const timer = setTimeout(finish, timeoutMs)
        timer.unref?.()
        child.once('exit', finish)
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
        killer.once('error', finish)
        killer.once('exit', finish)
      })
    } else {
      try {
        child.kill('SIGTERM')
      } catch {
        // 子进程可能已经在启动失败时退出。
      }
      await new Promise((resolve) => {
        let finished = false
        const finish = () => {
          if (finished) return
          finished = true
          clearTimeout(timer)
          resolve()
        }
        const timer = setTimeout(finish, timeoutMs)
        timer.unref?.()
        child.once('exit', finish)
      })
    }
  }
  child.stdout?.destroy()
  child.stderr?.destroy()
}

/**
 * 启动隔离 home 中的 dsh，并等待它打印带 token 的地址。
 * 统一传入 profile、overlay、loopback host/port、trustedHost 与 DSH_HOME，监听 stdout/stderr
 * 的 token；超时、启动错误或提前退出都会先清理进程，并带上 dsh 输出抛出原因。
 */
export async function startDsh({
  dshBin,
  profile,
  overlays,
  home,
  cwd,
  port,
  trustedHost,
  timeoutMs = 60_000,
  tokenPattern = /dsh web:\s*\S+?[?&]token=([\w.-]+)/u,
  timeoutMessage = (output) => `dsh 60 秒内没有打印访问地址：\n${output}`,
  exitMessage = (code, output) => `dsh 退出（code ${code}）：\n${output}`,
  errorMessage = (error, output) => `${error.message}\n${output}`,
}) {
  const child = spawn(process.execPath, [
    dshBin,
    '--profile', profile,
    ...overlays.flatMap((overlay) => ['--patch', overlay]),
    '--no-open',
    '--host', '127.0.0.1',
    '--port', String(port),
    '--trusted-host', trustedHost,
  ], {
    cwd,
    env: { ...process.env, DSH_HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let output = ''
  return await new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      void fail(new Error(timeoutMessage(output)))
    }, timeoutMs)
    const fail = async (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        await stopDsh(child)
      } finally {
        reject(error)
      }
    }
    const scan = (chunk) => {
      output += String(chunk)
      tokenPattern.lastIndex = 0
      const match = tokenPattern.exec(output)
      if (match === null || settled) return
      settled = true
      clearTimeout(timer)
      resolve({ child, token: match[1] })
    }
    child.stdout.on('data', scan)
    child.stderr.on('data', scan)
    child.once('error', (error) => {
      void fail(new Error(errorMessage(error, output)))
    })
    child.once('exit', (code) => {
      if (!settled) void fail(new Error(exitMessage(code, output)))
    })
  })
}

/**
 * 在 dsh 进程生命周期内运行检查，并保证成功或失败都结束进程树。
 * 先启动并把 `{ child, token }` 交给 run，run 返回或抛错后统一停止 dsh。
 */
export async function withDsh(options, run) {
  const started = await startDsh(options)
  try {
    return await run(started)
  } finally {
    await stopDsh(started.child)
  }
}
