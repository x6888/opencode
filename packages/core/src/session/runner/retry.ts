export * as SessionRunnerRetry from "./retry.js"

import { AIError, isRetryable } from "@opencode/ai"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { SessionError } from "@opencode/schema/session-error"
import { Clock, Duration, Effect, Pull, Schedule } from "effect"
import { Bus } from "../../bus.js"
import type { PluginHooks } from "../../plugin/hooks.js"
import { SessionEvent } from "../event.js"
import { SessionMessage } from "../message.js"
import { SessionSchema } from "../schema.js"

export { isRetryable }

interface Input {
  readonly cause: AIError
  readonly error: SessionError.Error
  readonly agent: Agent.ID
  readonly model: Model.Ref
  readonly hook: (event: PluginHooks.Domains["session"]["retry"]) => Effect.Effect<void>
  readonly retry: boolean
}

export interface Decision {
  readonly retry: true
  readonly attempt: number
  readonly delay: number
}

/** Bound provider-requested delays so a hostile or buggy retry-after cannot stall a session for hours. */
const RETRY_AFTER_MAX = Duration.toMillis("15 minutes")

// ---------------------------------------------------------------------------
// 策略抽取：把原本硬编码在核心循环中的退避参数、重试次数上限、超时重试上限、限流等待
// 解析（provider 声明值的截断与响应头名）与可重试判定扩展点抽离为可声明的 RetryPolicy，
// 核心循环改为消费策略。DEFAULT_RETRY_POLICY 逐字段对齐改造前的硬编码值，默认路径等价。
// 扩展点：向 RETRY_POLICIES 注册一条 RetryPolicy 即可覆盖某个 provider，无需改核心循环。
// ---------------------------------------------------------------------------

/** 携带 retry-after 的原因标签（默认 RateLimit / ProviderInternal）。 */
export type RetryAfterTag = "RateLimit" | "ProviderInternal"

/**
 * provider 特定处理拦截器：在通用判定之上按 provider 微调某一次重试。
 * 返回 undefined 表示不处理（继续默认）；首个非 undefined 的结果被采用。
 */
export type RetryPolicySpecialCase = (input: {
  readonly input: Input
  readonly attempt: number
  readonly timeouts: number
  readonly retry: boolean
  readonly delay: number
}) => { readonly retry?: boolean; readonly delay?: number } | undefined

export interface RetryPolicy {
  readonly name: string
  /** 常规失败的最大重试次数（对应 Schedule.recurs）。 */
  readonly maxRetries: number
  /** 超时失败的最大重试次数：一次超时已经等过很久，上限远低于常规值。 */
  readonly timeoutMaxRetries: number
  readonly backoff: {
    /** 指数退避的首次等待（Schedule.exponential 基数）。 */
    readonly initialDelay: Duration.Duration
    /** 退避因子。 */
    readonly factor: number
    /** 单次等待上限：指数增长被该值截断（Schedule.spaced）。 */
    readonly maxDelay: Duration.Duration
    /** 是否在等待上叠加抖动（Schedule.jittered）。 */
    readonly jitter: boolean
  }
  readonly rateLimit: {
    /** provider 声明的 retry-after 上限，防止恶意或异常值把会话拖上数小时。 */
    readonly maxDelay: Duration.Duration
    /** 从哪些原因标签读取 retry-after。 */
    readonly tags: readonly RetryAfterTag[]
    /** retry-after 响应头名（毫秒）：错误未携带 retryAfterMs 时兜底读取。 */
    readonly retryAfterMsHeaders: readonly string[]
    /** retry-after 响应头名（秒 / HTTP 日期）：兜底同上。 */
    readonly retryAfterHeaders: readonly string[]
  }
  readonly retryable: {
    /** 追加的可重试状态码：isRetryable 判为不可重试时仍重试。 */
    readonly statusCodes: readonly number[]
    /** 追加的可重试消息正则表：命中即重试。 */
    readonly messagePatterns: readonly RegExp[]
    /** 5xx 是否一律重试：默认不开启，5xx 的可重试性由 @opencode/ai 的错误分类决定。 */
    readonly retry5xx?: boolean
  }
  /** 追加的 provider 特定处理；默认为空 ⇒ 不改变任何判定。 */
  readonly specialCases?: readonly RetryPolicySpecialCase[]
}

// Exponential from 2s capped at 10s per gap, for 10 retries: 2, 4, 8, then 10 × 7, about 84s of
// waiting when every attempt fails (67–101s with jitter). `min` takes the faster schedule, so the
// cap applies per gap; `max` with `recurs` bounds the count.
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  name: "default",
  maxRetries: 10,
  // A timed-out attempt already waited minutes before failing, so the general allowance would let a
  // dead provider hold a step for most of an hour. Cap those attempts well below it.
  timeoutMaxRetries: 3,
  backoff: {
    initialDelay: Duration.seconds(2),
    factor: 2,
    maxDelay: Duration.seconds(10),
    jitter: true,
  },
  rateLimit: {
    maxDelay: Duration.millis(RETRY_AFTER_MAX),
    tags: ["RateLimit", "ProviderInternal"],
    retryAfterMsHeaders: ["retry-after-ms"],
    retryAfterHeaders: ["retry-after"],
  },
  retryable: {
    statusCodes: [],
    messagePatterns: [],
  },
}

// 模块级空表：默认没有任何 provider 覆盖 ⇒ 全部走默认策略（向后兼容）。
const RETRY_POLICIES: Record<string, RetryPolicy> = {}

export const selectPolicy = (provider: string): RetryPolicy => RETRY_POLICIES[provider] ?? DEFAULT_RETRY_POLICY

// 响应头兜底解析：与 @opencode/ai 的 retry-after 解析顺序一致（毫秒 → 秒 → HTTP 日期），
// 仅在错误未携带 retryAfterMs 时生效，因此默认路径不改变任何等待。
const headerRetryAfter = (policy: RetryPolicy, headers: Record<string, string> | undefined) => {
  if (!headers) return undefined
  for (const name of policy.rateLimit.retryAfterMsHeaders) {
    const value = headers[name]
    if (!value) continue
    const millis = Number(value)
    if (Number.isFinite(millis)) return Math.max(0, millis)
  }
  for (const name of policy.rateLimit.retryAfterHeaders) {
    const value = headers[name]
    if (!value) continue
    const seconds = Number(value)
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
    const date = Date.parse(value)
    if (!Number.isNaN(date)) return Math.max(0, date - Date.now())
  }
  return undefined
}

const retryAfter = (policy: RetryPolicy, input: Input) => {
  const reason = input.cause.reason
  if (reason._tag !== "RateLimit" && reason._tag !== "ProviderInternal") return undefined
  if (!policy.rateLimit.tags.includes(reason._tag)) return undefined
  const declared = reason.retryAfterMs ?? headerRetryAfter(policy, reason.http?.headers)
  return declared === undefined ? undefined : Math.min(declared, Duration.toMillis(policy.rateLimit.maxDelay))
}

/** 由策略构造调度：退避基数/因子/上限、重试次数、抖动与限流等待解析全部来自策略。 */
const scheduleFor = (policy: RetryPolicy) => {
  const bounded = Schedule.max([
    Schedule.min([
      Schedule.exponential(policy.backoff.initialDelay, policy.backoff.factor),
      Schedule.spaced(policy.backoff.maxDelay),
    ]),
    Schedule.recurs(policy.maxRetries),
  ])
  const paced = policy.backoff.jitter ? bounded.pipe(Schedule.jittered) : bounded
  return paced.pipe(
    Schedule.setInputType<Input>(),
    Schedule.modifyDelay(({ input, duration: delay }) => {
      const minimum = retryAfter(policy, input)
      const duration = minimum === undefined ? delay : Duration.max(delay, Duration.millis(minimum))
      return Effect.succeed(Duration.millis(Math.ceil(Duration.toMillis(duration))))
    }),
  )
}

const isTimeout = (error: AIError) => error.reason._tag === "Transport" && error.reason.code === "Timeout"

// 策略层的可重试扩展：默认 statusCodes / messagePatterns 为空且 retry5xx 未开启 ⇒ 恒等于调用方给出的 input.retry。
const retryableByPolicy = (input: Input, policy: RetryPolicy) => {
  if (input.retry) return true
  const status = input.cause.reason.http?.status
  if (status !== undefined) {
    if (policy.retryable.retry5xx === true && status >= 500) return true
    if (policy.retryable.statusCodes.includes(status)) return true
  }
  return policy.retryable.messagePatterns.some((pattern) => pattern.test(input.cause.reason.message))
}

export const policy = (sessionID: SessionSchema.ID) =>
  Effect.gen(function* () {
    let active: RetryPolicy = DEFAULT_RETRY_POLICY
    let step = yield* Schedule.toStep(scheduleFor(active))
    let attempt = 1
    let timeouts = 0
    return (input: Input) =>
      Effect.gen(function* () {
        // 策略按 provider 解析：注册表默认为空 ⇒ 恒为 DEFAULT_RETRY_POLICY，等价于原硬编码行为。
        const selected = selectPolicy(input.model.providerID)
        if (selected !== active) {
          active = selected
          step = yield* Schedule.toStep(scheduleFor(selected))
        }
        const now = yield* Clock.currentTimeMillis
        const next = yield* step(now, input).pipe(Pull.catchDone(() => Effect.succeed(undefined)))
        if (!next) return { retry: false as const }
        const [, duration] = next
        attempt++
        if (isTimeout(input.cause)) timeouts++
        let delay = Math.ceil(Duration.toMillis(duration))
        let retry = retryableByPolicy(input, active) && timeouts <= active.timeoutMaxRetries
        // provider 特定处理：首个命中的拦截器生效，未命中则完全走默认。
        for (const specialCase of active.specialCases ?? []) {
          const result = specialCase({ input, attempt, timeouts, retry, delay })
          if (result === undefined) continue
          if (result.retry !== undefined) retry = result.retry
          if (result.delay !== undefined) delay = result.delay
          break
        }
        const event: PluginHooks.Domains["session"]["retry"] = {
          sessionID,
          agent: input.agent,
          model: input.model,
          error: input.error,
          attempt,
          decision: retry ? { retry: true, delay } : { retry: false },
        }
        yield* input.hook(event)
        if (!event.decision.retry) return event.decision
        const normalized =
          Number.isFinite(event.decision.delay) && event.decision.delay >= 0 ? Math.ceil(event.decision.delay) : delay
        return { retry: true as const, attempt, delay: normalized }
      })
  })

export const make = (bus: Bus.Interface, sessionID: SessionSchema.ID) =>
  Effect.gen(function* () {
    const decide = yield* policy(sessionID)
    const wait = (input: {
      readonly decision: Decision
      readonly assistantMessageID: SessionMessage.ID
      readonly error: SessionError.Error
    }) =>
      Effect.gen(function* () {
        const scheduled = yield* Clock.currentTimeMillis
        yield* bus.publish(SessionEvent.RetryScheduled, {
          sessionID,
          assistantMessageID: input.assistantMessageID,
          attempt: input.decision.attempt,
          at: scheduled + input.decision.delay,
          error: input.error,
        })
        const remaining = Math.max(0, scheduled + input.decision.delay - (yield* Clock.currentTimeMillis))
        yield* Effect.sleep(Duration.millis(remaining))
      })
    return { decide, wait }
  })
