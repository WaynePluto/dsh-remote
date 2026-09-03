/**
 * The notifier, against a fake spawner.
 *
 * The property worth testing is the one the design turns on: caller text NEVER
 * reaches the script. If a future edit reintroduces interpolation, a session
 * title containing a quote would start running as PowerShell, and no other test
 * in this package would notice.
 */

import { describe, expect, it } from 'vitest'
import {
  APP_ID, clampLine, DISMISS_LABEL, ENV, MAX_IN_FLIGHT, TOAST_SCRIPT, WindowsToastNotifier,
} from '../src/toast.js'
import type { ExecFile } from '../src/toast.js'

/** One recorded spawn. */
interface Spawned {
  file: string
  args: readonly string[]
  options: { env?: NodeJS.ProcessEnv; windowsHide?: boolean; timeout?: number }
}

/**
 * A spawner that records calls and settles them on demand.
 * @param behaviour - how each call should settle.
 * @returns the fake and the calls it recorded.
 */
function fakeExec(behaviour: 'ok' | 'fail' | 'hang' = 'ok'): {
  exec: ExecFile
  calls: Spawned[]
  settle: () => void
} {
  const calls: Spawned[] = []
  const pending: (() => void)[] = []
  const exec = ((file: string, args: readonly string[], options: Spawned['options'], done: (error: Error | null) => void) => {
    calls.push({ file, args, options })
    const finish = (): void => {
      if (behaviour === 'fail') done(new Error('powershell.exe not found'))
      else done(null)
    }
    if (behaviour === 'hang') pending.push(finish)
    else queueMicrotask(finish)
    return {} as never
  }) as unknown as ExecFile
  return { exec, calls, settle: () => { for (const run of pending.splice(0)) run() } }
}

/** A notifier that believes it is on Windows and spawns the given fake. */
function notifier(exec: ExecFile, env: NodeJS.ProcessEnv = {}): WindowsToastNotifier {
  return new WindowsToastNotifier({ platform: 'win32', exec, env })
}

describe('shortening a line', () => {
  it('leaves an ordinary line alone', () => {
    expect(clampLine('任务已完成，等待输入', 90)).toBe('任务已完成，等待输入')
  })

  it('flattens the whitespace a model-written title can contain', () => {
    // A raw newline does not break the document — the value never reaches the
    // parser as markup — but it lays the toast out wrongly, and a NUL cannot
    // be carried in an environment variable at all.
    expect(clampLine('two\nlines\u0000here', 90)).toBe('two lines here')
    expect(clampLine('  padded\t\tout  ', 90)).toBe('padded out')
  })

  it('truncates with an ellipsis rather than letting Windows decide', () => {
    expect(clampLine('x'.repeat(200), 10)).toBe(`${'x'.repeat(9)}…`)
  })
})

describe('the script', () => {
  it('is a constant that contains no caller data at all', () => {
    // The design claim: there is no escaping function to get wrong, because
    // there is no interpolation.
    expect(TOAST_SCRIPT).toContain(`$env:${ENV.title}`)
    expect(TOAST_SCRIPT).toContain(`$env:${ENV.body}`)
    expect(TOAST_SCRIPT).toContain(`$env:${ENV.appId}`)
    expect(TOAST_SCRIPT).not.toContain(APP_ID)
    expect(TOAST_SCRIPT).not.toContain(DISMISS_LABEL)
  })

  it('asks for a toast that stays until it is dismissed', () => {
    // `scenario=reminder` is what makes it persist, and the scenario is only
    // honoured when the toast carries at least one action.
    expect(TOAST_SCRIPT).toContain(`SetAttribute('scenario', 'reminder')`)
    expect(TOAST_SCRIPT).toContain(`CreateElement('actions')`)
  })
})

describe('sending one toast', () => {
  it('passes every piece of text through the environment', async () => {
    const { exec, calls } = fakeExec()
    await notifier(exec, { PATH: '/usr/bin' }).send({ title: "it's done", body: 'body' })

    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.file).toBe('powershell.exe')
    expect(call.args).toEqual(['-NoProfile', '-NonInteractive', '-Command', TOAST_SCRIPT])
    expect(call.options.env?.[ENV.title]).toBe("it's done")
    expect(call.options.env?.[ENV.body]).toBe('body')
    expect(call.options.env?.[ENV.appId]).toBe(APP_ID)
    // The ambient environment still reaches the child; the four values are
    // added to it, not substituted for it.
    expect(call.options.env?.['PATH']).toBe('/usr/bin')
  })

  it('never lets caller text into the command line', async () => {
    const { exec, calls } = fakeExec()
    const hostile = `'; Remove-Item C:\\ -Recurse; '`
    await notifier(exec).send({ title: hostile, body: hostile })

    // The whole argv is the constant script; the hostile string is only ever
    // an environment value, which `CreateTextNode` escapes into the document.
    expect(calls[0]!.args.join(' ')).not.toContain('Remove-Item')
    expect(calls[0]!.options.env?.[ENV.title]).toContain('Remove-Item')
  })

  it('hides the console window so the terminal keeps its title', async () => {
    const { exec, calls } = fakeExec()
    await notifier(exec).send({ title: 't', body: 'b' })
    expect(calls[0]!.options.windowsHide).toBe(true)
    expect(calls[0]!.options.timeout).toBeGreaterThan(0)
  })

  it('does nothing at all off Windows', async () => {
    const { exec, calls } = fakeExec()
    const linux = new WindowsToastNotifier({ platform: 'linux', exec })
    expect(linux.supported).toBe(false)
    await linux.send({ title: 't', body: 'b' })
    expect(calls).toHaveLength(0)
  })

  it('reports a notifier that ran and failed, so the test button can say why', async () => {
    const { exec } = fakeExec('fail')
    await expect(notifier(exec).send({ title: 't', body: 'b' }))
      .rejects.toThrow('powershell.exe not found')
  })

  it('drops the surplus of a burst instead of queueing it', async () => {
    // Notifications are only interesting while they are fresh, so the right
    // answer to a backlog is to skip it, not to show it late.
    const { exec, calls, settle } = fakeExec('hang')
    const toast = notifier(exec)
    const flight = Array.from({ length: MAX_IN_FLIGHT + 3 }, async () =>
      await toast.send({ title: 't', body: 'b' }))
    expect(calls).toHaveLength(MAX_IN_FLIGHT)
    settle()
    await Promise.all(flight)
    expect(calls).toHaveLength(MAX_IN_FLIGHT)
  })

  it('lets the next notification through once the burst clears', async () => {
    const { exec, calls, settle } = fakeExec('hang')
    const toast = notifier(exec)
    const first = toast.send({ title: 't', body: 'b' })
    settle()
    await first

    const second = toast.send({ title: 't2', body: 'b2' })
    settle()
    await second
    expect(calls).toHaveLength(2)
  })
})

describe('the real notifier', () => {
  it('decides support from the platform it is actually on', () => {
    const real = new WindowsToastNotifier()
    expect(real.supported).toBe(process.platform === 'win32')
  })

  it('accepts an AppID override, because an unregistered one can be silent', async () => {
    const { exec, calls } = fakeExec()
    const custom = new WindowsToastNotifier({ platform: 'win32', exec, appId: 'Other', env: {} })
    await custom.send({ title: 't', body: 'b' })
    expect(calls[0]!.options.env?.[ENV.appId]).toBe('Other')
  })
})
