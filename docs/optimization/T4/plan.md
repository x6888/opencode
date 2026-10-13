# T4 优化计划：session/retry.ts 重试/限流策略可配置化 / 插件化

> 子 Agent：规划者（流程 4.2）。本文仅做规划，**不改代码**。
> 目标文件：`packages/opencode/src/session/retry.ts`（基线 209 行，已 Read）。
> 改动约束：仅限 `retry.ts` 单文件；无新依赖；保留现有导出与调用方语义；默认策略等价于原行为。

---

## 一、优化目标

将当前硬编码在 `retry.ts` 核心逻辑中的**退避参数、最大重试次数、可重试判定规则（状态码/正则）、限流等待解析（响应头名）、provider 特定 upsell 逻辑**抽出为可声明的 `RetryPolicy` 结构；核心 retry 循环改为**消费策略**而非特定 provider 硬编码；并提供按 provider 覆盖的注册表作为扩展点。默认策略与原行为完全等价（向后兼容）。

---

## 二、当前实现分析（基于 retry.ts 实际代码）

### 2.1 硬编码常量（L26–L31）
```text
RETRY_INITIAL_DELAY = 2000
RETRY_BACKOFF_FACTOR = 2
RETRY_JITTER_FACTOR = 0.25
RETRY_MAX_DELAY_NO_HEADERS = 30_000
RETRY_MAX_DELAY = 2_147_483_647
RETRY_MAX_RETRIES = 5
```
被 `exponential` / `cap` / `delay` / `policy` 直接引用，无法按 provider 调整。

### 2.2 退避计算（L43–L83）
- `cap(ms)`（L43）：用全局 `RETRY_MAX_DELAY` 截断。
- `delay(attempt, error?, random)`（L47–L78）：限流等待解析**硬编码** `retry-after-ms`（L51）、`retry-after`（L59）两个头名；无头时用 `RETRY_MAX_DELAY_NO_HEADERS` 截断（L77）。
- `exponential(attempt, random)`（L80–L83）：直接用 `RETRY_INITIAL_DELAY` / `RETRY_BACKOFF_FACTOR` / `RETRY_JITTER_FACTOR`，不接收任何配置参数。

### 2.3 可重试判定（L85–L155）
- `retryable(error, provider)`（L85–L155）：
  - L88–L98：`SessionV1.APIError` 分支，**5xx 强制重试硬编码**（`status >= 500`，L94）；用 `error.data.isRetryable` + `matchesRetryableMessage`。
  - L99–L111：`FreeUsageLimitError` 硬编码 upsell（固定 message/action）。
  - L112–L144：`GoUsageLimitError` 硬编码处理（parseJSON + retry-after 解析 + 重置文案拼装）。
  - L145：普通 APIError 返回 message；`Overloaded` 文案特例。
  - L148–L154：非 APIError 的 message 模式匹配（`too_many_requests` / `exhausted` / `unavailable` / pattern）。
- `matchesRetryableMessage`（L157–L159）：使用单一硬编码 `RETRYABLE_MESSAGE_PATTERNS`。
- `RETRYABLE_MESSAGE_PATTERNS`（L33–L41）：6 条正则，全局共享，不可按 provider 调整。

### 2.4 核心循环（L183–L207）
- `policy(opts)`（L183–L207）：`Schedule.fromStepWithMetadata`，内部调用 `retryable(error, opts.provider)` 与 `delay(meta.attempt, ...)`，并用 `RETRY_MAX_RETRIES` 截断（L193）。所有策略相关值来自全局常量/全局函数，**无策略入参**。

### 2.5 对照验收标准 1/2 的硬编码点
| 应进入策略的维度 | 现状位置 | 改造落点 |
|---|---|---|
| 退避基数/因子/抖动/上限/最大重试 | 全局常量 + `exponential`/`cap`/`delay` | `RetryPolicy.backoff` / `.maxRetries` |
| 可重试规则（5xx 覆盖、状态码、正则） | `retryable`（L88–L98）+ `matchesRetryableMessage` + `RETRYABLE_MESSAGE_PATTERNS` | `RetryPolicy.retryable` |
| 限流等待解析（响应头名） | `delay`（L51/L59） | `RetryPolicy.rateLimit` |
| provider 特定 upsell 逻辑 | `retryable`（L99–L144） | `RetryPolicy.specialCases` 拦截器（默认策略包含它们 ⇒ 等价于原行为） |

---

## 三、优化方案（伪码）

### 3.1 类型 `RetryPolicy`（新增，模块级）
```ts
export type RetryPolicy = {
  name: string
  maxRetries: number
  backoff: {
    initialDelay: number
    factor: number
    jitter: number
    maxDelay: number
    maxDelayNoHeaders: number
  }
  retryable: {
    retry5xx?: boolean                 // 默认 true：保留原 status>=500 强制重试
    statusCodes?: number[]             // 额外明确可重试状态码（如 [429]）
    messagePatterns: RegExp[]
  }
  rateLimit?: {
    retryAfterMsHeaders: string[]      // 默认 ["retry-after-ms"]
    retryAfterHeaders: string[]        // 默认 ["retry-after"]
  }
  // 特殊重试结果拦截器：以规则得到的 base Retryable 为输入
  // 返回 Retryable 表示覆盖/补充；返回 undefined 表示不处理（继续默认）
  specialCases?: Array<(input: {
    error: Err
    provider: string
    base: Retryable | undefined
  }) => Retryable | undefined>
}
```
> 兼容性：`RetryPolicy` 为新增导出类型，不影响既有导出（`delay` / `retryable` / `policy` / `SessionRetry` / `GO_UPSELL_*`）。

### 3.2 默认策略对象 `DEFAULT_RETRY_POLICY`（模块级 const，等价原行为）
```ts
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  name: "default",
  maxRetries: RETRY_MAX_RETRIES,                  // 5，保留原常量
  backoff: {
    initialDelay: RETRY_INITIAL_DELAY,            // 2000
    factor: RETRY_BACKOFF_FACTOR,                 // 2
    jitter: RETRY_JITTER_FACTOR,                  // 0.25
    maxDelay: RETRY_MAX_DELAY,                    // 2_147_483_647
    maxDelayNoHeaders: RETRY_MAX_DELAY_NO_HEADERS,// 30_000
  },
  retryable: {
    retry5xx: true,                               // 保留 status>=500 强制重试
    messagePatterns: RETRYABLE_MESSAGE_PATTERNS,
  },
  rateLimit: {
    retryAfterMsHeaders: ["retry-after-ms"],
    retryAfterHeaders: ["retry-after"],
  },
  specialCases: [freeTierUpsell, goLimitUpsell], // 原两个硬编码块平移为拦截器
}
```
> `freeTierUpsell` / `goLimitUpsell`：将 L99–L111、L112–L144 现有逻辑**原样封装**为符合 `specialCases` 签名的纯函数，复用既有 `parseJSON` / `str` / `num` / `iife` / `GO_UPSELL_*`，**不新增依赖**。

### 3.3 策略选择（provider 维度，扩展点）
```ts
// 模块级空表：默认无任何 provider 覆盖 ⇒ 全部走默认，保证向后兼容
const RETRY_POLICIES: Record<string, RetryPolicy> = {}

export function selectPolicy(provider: string): RetryPolicy {
  return RETRY_POLICIES[provider] ?? DEFAULT_RETRY_POLICY
}
```
> 未来扩展：向 `RETRY_POLICIES` 注册一条 `RetryPolicy` 即可覆盖某 provider，无需改核心循环。可选增强（不在本任务默认实现内，避免行为漂移）：如需按 status 选择，可在 `selectPolicy` 内加二级判断。

### 3.4 核心消费改造
- `exponential(attempt, random, policy = DEFAULT_RETRY_POLICY)`：用 `policy.backoff.{initialDelay,factor,jitter}` 替代全局常量。
- `cap(ms, maxDelay = RETRY_MAX_DELAY)`：新增可选 `maxDelay` 参数（默认沿用全局，向后兼容）。
- `delay(attempt, error?, random = Math.random(), policy = DEFAULT_RETRY_POLICY)`：头名取自 `policy.rateLimit`；无头截断用 `policy.backoff.maxDelayNoHeaders`；最终 `cap` 用 `policy.backoff.maxDelay`。
- `retryable(error, provider, policy = DEFAULT_RETRY_POLICY)`：
  1. `ContextOverflowError` 仍直接 `undefined`（不变）。
  2. APIError 分支：`policy.retryable.retry5xx` 决定是否 `status>=500` 强制重试；`matchesRetryableMessage` 改读 `policy.retryable.messagePatterns`；保留 `isRetryable` 短路。
  3. **specialCases 串联**：以规则得到的 `base` Retryable 为输入，依次执行 `policy.specialCases`，首个非 `undefined` 即采用（原 `FreeUsageLimitError` / `GoUsageLimitError` 分支平移为两个拦截器，顺序与原 if 链一致）。
  4. 非 APIError 的 message 匹配保持，使用 `policy.retryable.messagePatterns`。
- `policy(opts)`（L183）：首行 `const rp = selectPolicy(opts.provider)`，后续 `retryable(error, opts.provider, rp)` 与 `delay(meta.attempt, ..., rp)`，并用 `rp.maxRetries` 替代 `RETRY_MAX_RETRIES` 截断（L193）。

> 导出兼容：`delay` / `retryable` 仅**追加尾部可选参数**（默认 `DEFAULT_RETRY_POLICY`），既有 2/3 参调用方签名不变（验收 4）。

---

## 四、预期收益
- **算法/架构**：重试策略从「全局硬编码」变为「声明式配置 + 插件注册表」，新增/覆盖 provider 零侵入核心循环。
- **可扩展性**：新增 provider 仅需向 `RETRY_POLICIES` 注册一条 `RetryPolicy`，可单独调退避、最大重试、可重试正则、限流头名、upsell 逻辑。
- **可测试性**：策略与算法解耦，默认等价性可静态走查。
- **零依赖、单文件**：满足全部约束。

---

## 五、风险与回退
| 风险 | 影响 | 缓解/回退 |
|---|---|---|
| R1 默认策略与原行为不等价（退避数值、消息正则、specialCases 顺序差异） | 验收 2/5 失败、调用方行为漂移 | 默认对象逐字段映射原常量；specialCases 顺序与原 if 链严格一致；旧全局常量保留作 DEFAULT 取值来源；提供 before/after 走查表（steps.md §步骤 7） |
| R2 策略选择优先级歧义（provider 覆盖意外屏蔽默认） | 部分 provider 行为改变 | 默认 `RETRY_POLICIES` 为空 ⇒ 全走默认；`selectPolicy` 仅「有则覆盖、无则默认」 |
| R3 `delay` / `retryable` 签名变更破坏既有调用 | 验收 4 失败 | 仅追加尾部可选参数且默认 DEFAULT，既有 2/3 参调用不受影响 |
| R4 `Schedule` 行为因闭包捕获策略变化异常 | 验收 4 失败 | `policy()` 内每次调用 `selectPolicy`，闭包仅捕获 `opts`，策略在 step 内解析 |

回退方案：新策略为增量添加，旧路径不删即可并存；若等价性无法静态确认，保留原 `delay` / `retryable` / `exponential` 全局常量版本。

---

## 六、逐条验收对照表
| 验收标准 | 对应设计 | 满足方式 |
|---|---|---|
| 1 抽出可配置 RetryPolicy（退避基数/最大重试/可重试匹配规则/限流等待解析） | §3.1 + §3.2 | `backoff` / `maxRetries` / `retryable` / `rateLimit` 四子结构全覆盖 |
| 2 核心循环复用策略、不硬编码 provider、默认等价 | §3.3 + §3.4 | `policy()` 经 `selectPolicy` 取策略；provider 特定逻辑下沉为 `specialCases`；默认对象等价原行为 |
| 3 仅限 retry.ts 单文件、无新依赖、TS 风格一致 | 全方案 | 新类型/常量/函数均在文件内；仅用既有 import + 既有辅助函数；命名沿用 UPPER_CASE / camelCase |
| 4 保留导出与调用方语义 | §3.4 签名兼容 | `delay` / `retryable` 仅追加可选参数；`policy` / `SessionRetry` / `GO_UPSELL_*` 导出不变；`Retryable` / `Cause.done` 语义不变 |
| 5 before/after 说明 + 静态核对 | steps.md | steps.md 每步含 before/after 对照与静态核对（grep / 类型 / 等价走查） |
