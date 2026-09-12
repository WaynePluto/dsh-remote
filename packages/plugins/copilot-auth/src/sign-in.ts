/** Copilot OAuth sign-in 的 Host orchestration；状态和 credential 只通过项目 service 持久化。 */

import type { Context } from '@deepseek-ai/cordis'
import { createModels } from '@earendil-works/pi-ai'
import type { AuthEvent, AuthPrompt } from '@earendil-works/pi-ai'
import { githubCopilotProvider } from '@earendil-works/pi-ai/providers/github-copilot'
import { credentialStoreFor, describeGrant, RECORD_KEY } from './credential-store.js'
import { ensureProviderRoute, isRouteConfigured, subscriptionAuthWarning } from './provider-route.js'
import { PROVIDER_ID } from './shared.js'
import type { CopilotAttemptView, CopilotStatusView } from './shared.js'

/** 一个正在进行的尝试。 */
interface Attempt {
  /** 撤销流程；插件 fiber dispose 时也会触发。 */
  readonly controller: AbortController
  /** 页面为本次尝试渲染的状态；整体替换，不原地修改。 */
  view: CopilotAttemptView
}

/** 任意形状失败的可读文本。 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** sign-in controller；由 RPC 调用 status/start/configure/cancel/signOut。 */
export class CopilotSignIn {
  private attempt: Attempt | undefined
  /** 上一次尝试失败原因；保留到下一次开始。 */
  private failure: string | undefined
  /** 最近一次成功登录未进入模型 picker 的原因。 */
  private routeFailure: string | undefined

  /** 绑定 Host context；credentials/settings 由调用时读取。 */
  constructor(private readonly ctx: Context) {}

  /** 读取 credential、route 和当前尝试状态，返回页面 snapshot。 */
  async status(): Promise<CopilotStatusView> {
    const credentials = this.ctx.get('credentials')
    const record = credentials === undefined ? undefined : await credentials.readRecord(RECORD_KEY)
    const grant = describeGrant(record)
    const warning = [this.routeFailure, grant.signedIn ? subscriptionAuthWarning(this.ctx) : undefined]
      .filter((message): message is string => message !== undefined).join('\n')
    return {
      signedIn: grant.signedIn,
      routeConfigured: isRouteConfigured(this.ctx),
      modelIds: grant.modelIds,
      ...this.attempt === undefined ? {} : { attempt: this.attempt.view },
      ...this.failure === undefined ? {} : { error: this.failure },
      ...warning === '' ? {} : { warning },
    }
  }

  /** 启动一次非阻塞 device-code/OAuth 流程；HTTP 调用立即返回当前状态。 */
  async start(): Promise<CopilotStatusView> {
    if (this.attempt !== undefined) return await this.status()
    this.failure = undefined
    this.routeFailure = undefined
    const controller = new AbortController()
    const attempt: Attempt = { controller, view: { phase: 'starting' } }
    this.attempt = attempt
    // 刻意不 await：流程会持续到用户完成
    // device code 授权，而调用方只是一次 HTTP 请求。
    void this.run(attempt)
    return await this.status()
  }

  /** 登录成功后写入/修复 provider route，并回读状态。 */
  async configure(): Promise<CopilotStatusView> {
    this.routeFailure = undefined
    const grant = describeGrant(await this.ctx.get('credentials')?.readRecord(RECORD_KEY))
    if (!grant.signedIn) return await this.status()
    await this.writeRoute(grant.modelIds)
    return await this.status()
  }

  /** 取消当前 device-code 尝试。 */
  cancel(): void {
    this.attempt?.controller.abort()
  }

  /** 取消尝试并删除本插件 credential record。 */
  async signOut(): Promise<CopilotStatusView> {
    this.cancel()
    this.failure = undefined
    this.routeFailure = undefined
    await this.ctx.get('credentials')?.deleteRecord(RECORD_KEY)
    return await this.status()
  }

  /** 插件卸载时取消并清除当前尝试。 */
  dispose(): void {
    this.attempt?.controller.abort()
    this.attempt = undefined
  }

  /** 执行 pi-ai login，观察 AuthEvent，并在成功后配置 route。 */
  private async run(attempt: Attempt): Promise<void> {
    try {
      const models = createModels({ credentials: credentialStoreFor(this.ctx) })
      models.setProvider(githubCopilotProvider())
      // pi-ai 通过上面的 store 持久化 credential，这正是
      // 它写入 dsh 自己记录而非副本的原因。
      await models.login(PROVIDER_ID, 'oauth', {
        signal: attempt.controller.signal,
        notify: (event) => { this.observe(attempt, event) },
        prompt: async prompt => await this.answer(prompt),
      })
      const grant = describeGrant(await this.ctx.get('credentials')?.readRecord(RECORD_KEY))
      await this.writeRoute(grant.modelIds)
    } catch (error: unknown) {
      // aborted 尝试表示用户按下 Cancel（或插件
      // 卸载）；把它报告为失败会给
      // 用户的主动操作标红。
      if (!attempt.controller.signal.aborted) {
        this.failure = messageOf(error)
        this.ctx.logger?.warn('copilot-auth: sign-in failed: %s', this.failure)
      }
    } finally {
      // 只有本次尝试仍是当前尝试时：取消后
      // 新启动不能被失败者退出时清掉。
      if (this.attempt === attempt) this.attempt = undefined
    }
  }

  /** 将成功登录的 model ids 交给 route 规划器；失败保留给页面显示。 */
  private async writeRoute(modelIds: readonly string[]): Promise<void> {
    try {
      await ensureProviderRoute(this.ctx, modelIds)
    } catch (error: unknown) {
      this.routeFailure = messageOf(error)
      this.ctx.logger?.warn('copilot-auth: signed in, but the provider route was refused: %s', this.routeFailure)
    }
  }

  /** 将 device_code/auth_url/info/progress 映射为页面尝试状态。 */
  private observe(attempt: Attempt, event: AuthEvent): void {
    switch (event.type) {
      case 'device_code':
        attempt.view = {
          phase: 'awaiting',
          userCode: event.userCode,
          verificationUri: event.verificationUri,
          ...event.expiresInSeconds === undefined
            ? {}
            : { expiresAt: Date.now() + event.expiresInSeconds * 1000 },
        }
        return
      case 'auth_url':
        attempt.view = {
          ...attempt.view,
          verificationUri: event.url,
          ...event.instructions === undefined ? {} : { message: event.instructions },
        }
        return
      case 'info':
        attempt.view = { ...attempt.view, message: event.message }
        return
      default:
        // `progress` 以及未来 pi-ai 新增的事件：code 已
        // 完成使命，因此尝试进入 finishing 而非继续等待。
        attempt.view = {
          phase: attempt.view.phase === 'awaiting' ? 'finishing' : attempt.view.phase,
          ...'message' in event && typeof event.message === 'string' ? { message: event.message } : {},
        }
    }
  }

  /** device-code 流程只接受空 text prompt；其他 prompt 明确拒绝。 */
  private async answer(prompt: AuthPrompt): Promise<string> {
    if (prompt.type === 'text') return ''
    throw new Error(
      `copilot-auth: the GitHub sign-in asked for "${prompt.message}", which this plugin cannot answer`
      + ' (it supports github.com device-code sign-in only)',
    )
  }
}
