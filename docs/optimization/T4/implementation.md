# T4 实现说明（改码者 / 流程 4.3）

> 文件：仅 `packages/opencode/src/session/retry.ts`（单文件、无新依赖、现有 import 与 TS 风格保持、导出与调用方语义兼容）。
> 配套：plan.md、steps.md。
> 结论：**默认策略与原行为完全等价**；未发现 plan 与文件冲突（plan 分析与实际代码一致，按 steps 顺序落地）。

---

## 一、一句话改了什么

将 `retry.ts` 中硬编码在核心循环里的退避参数、最大重试次数、可重试判定规则（状态码/正则）、限流等待解析（响应头名）与 provider 特定 upsell 逻辑，抽出为声明式 `RetryPolicy` 类型 + `DEFAULT_RETRY_POLICY`（逐字段等价原行为）+ 可扩展注册表 `RETRY_POLICIES`/`selectPolicy`；核心 retry 循环改为经 `selectPolicy(provider)` 消费策略，provider 特定逻辑下沉为 `specialCases` 拦截器。

---

## 二、关键 diff 摘要

### 2.1 新增 `RetryPolicy` 类型（模块级导出）
- 含 `name`、`maxRetries`、`backoff{initialDelay,factor,jitter,maxDelay,maxDelayNoHeaders}`、`retryable{retry5xx?,statusCodes?,messagePatterns}`、`rateLimit?{retryAfterMsHeaders,retryAfterHeaders}`、`specialCases?`（拦截器数组）。

### 2.2 新增 `DEFAULT_RETRY_POLICY`（模块级 const，等价原行为）
| 字段 | 取值 | 原硬编码来源 |
|---|---|---|
| maxRetries | `RETRY_MAX_RETRIES` | 5 |
| backoff.initialDelay | `RETRY_INITIAL_DELAY` | 2000 |
| backoff.factor | `RETRY_BACKOFF_FACTOR` | 2 |
| backoff.jitter | `RETRY_JITTER_FACTOR` | 0.25 |
| backoff.maxDelay | `RETRY_MAX_DELAY` | 2_147_483_647 |
| backoff.maxDelayNoHeaders | `RETRY_MAX_DELAY_NO_HEADERS` | 30_000 |
| retryable.retry5xx | `true` | 原 `status>=500` 强重试 |
| retryable.messagePatterns | `RETRYABLE_MESSAGE_PATTERNS` | 6 条正则原样 |
| rateLimit.retryAfterMsHeaders | `["retry-after-ms"]` | 原 `delay` L51 |
| rateLimit.retryAfterHeaders | `["retry-after"]` | 原 `delay` L59 |
| specialCases | `[freeTierUpsell, goLimitUpsell]` | 原 L99–L144 平移 |

### 2.3 新增 `freeTierUpsell` / `goLimitUpsell`（specialCases 拦截器）
- 原 `FreeUsageLimitError` / `GoUsageLimitError` 内联分支**原样平移**为纯函数，复用既有 `parseJSON`/`str`/`num`/`iife`/`GO_UPSELL_*`，顺序保持 freeTier → goLimit（与原 if 链一致）。

### 2.4 新增 `RETRY_POLICIES` 注册表与 `selectPolicy`（扩展点）
```ts
const RETRY_POLICIES: Record<string, RetryPolicy> = {} // 默认空 ⇒ 全走默认
export function selectPolicy(provider: string): RetryPolicy {
  return RETRY_POLICIES[provider] ?? DEFAULT_RETRY_POLICY
}
```

### 2.5 核心函数消费策略（签名尾部追加可选参数，默认 DEFAULT，向后兼容）
- `cap(ms, maxDelay = RETRY_MAX_DELAY)`：新增可选 `maxDelay`。
- `exponential(attempt, random, policy = DEFAULT_RETRY_POLICY)`：用 `policy.backoff.*` 替代全局常量。
- `delay(attempt, error?, random = Math.random(), policy = DEFAULT_RETRY_POLICY)`：头名取自 `policy.rateLimit`，无头截断用 `policy.backoff.maxDelayNoHeaders`，最终 `cap` 用 `policy.backoff.maxDelay`。
- `retryable(error, provider, policy = DEFAULT_RETRY_POLICY)`：`retry5xx`/`statusCodes` 决定是否强重试，`matchesRetryableMessage` 改读 `policy.retryable.messagePatterns`，原 upsell 内联块删除改为串联 `policy.specialCases`（首个非 `undefined` 即采用），否则返回 `base`（含 Overloaded 文案特例）。
- `matchesRetryableMessage(value, patterns = RETRYABLE_MESSAGE_PATTERNS)`：新增 `patterns` 参数。
- `policy(opts)`：首行 `const rp = selectPolicy(opts.provider)`，后续 `retryable(error, opts.provider, rp)`、`delay(meta.attempt, ..., Math.random(), rp)`、`meta.attempt > rp.maxRetries` 替代 `RETRY_MAX_RETRIES`。

---

## 三、Before / After 对照（默认路径等价走查）

### Before（原行为）
- 退避/重试/限流/upsell 全部硬编码于全局常量与 `retryable`/`delay` 内联分支；provider 特定逻辑无法按 provider 调整。

### After（策略驱动）
- 以上全部声明于 `DEFAULT_RETRY_POLICY`；核心循环经 `selectPolicy` 取策略；新增 provider 仅需 `RETRY_POLICIES[provider] = <RetryPolicy>`。

### 等价性逐项核对（代入 `DEFAULT_RETRY_POLICY`）
| 输入样本 | 原结果 | 新结果 | 等价 |
|---|---|---|---|
| `status=503, isRetryable=false` | retryable（`status>=500`） | `retry5xx=true` ⇒ retryable | ✅ |
| `429` + `retry-after` 头 | `delay` 解析头值 | 头名来自 `policy.rateLimit` `["retry-after"]`，数值同 | ✅ |
| `429` + `retry-after-ms` 头 | 解析毫秒头 | `["retry-after-ms"]` 同 | ✅ |
| 无头限流 | `cap(min(exp,30000))` | `cap(min(exp,maxDelayNoHeaders),maxDelay)`（30000<maxDelay 恒等） | ✅ |
| `FreeUsageLimitError` body | 固定 upsell（`specialCases[0]`） | 同结构 | ✅ |
| `GoUsageLimitError` body | 重置文案（`specialCases[1]`） | 同结构 | ✅ |
| 普通超时 message | 命中 `RETRYABLE_MESSAGE_PATTERNS` | 命中 `policy.retryable.messagePatterns`（同引用） | ✅ |
| `attempt > 5` | `Cause.done` | `rp.maxRetries=5` ⇒ `Cause.done` | ✅ |

### 导出不变核对
- 保留：`delay` / `retryable` / `policy` / `GO_UPSELL_MESSAGE` / `GO_UPSELL_URL` / `SessionRetry` / `Retryable` / `Err`。
- 仅新增导出：`RetryPolicy`（类型）、`DEFAULT_RETRY_POLICY`、`selectPolicy`。
- `delay`/`retryable` 仅追加尾部可选参数（默认 `DEFAULT_RETRY_POLICY`），既有 2/3 参调用签名不变。
- 无新增 `import`、无外部包引用（单文件、零依赖）。

---

## 四、风险与回退
- R1（等价性）：默认对象逐字段映射原常量；specialCases 顺序与原 if 链严格一致；全局 `RETRY_*` 常量保留作 DEFAULT 取值来源，走查见上表 —— 等价确认。
- R2（覆盖优先级）：`RETRY_POLICIES` 默认空 ⇒ 全走默认；`selectPolicy` 仅「有则覆盖、无则默认」。
- R3（签名破坏）：仅追加尾部可选参数且默认 DEFAULT，既有调用不受影响。
- R4（`Schedule` 闭包）：`policy()` 内每次 step 调用 `selectPolicy`，闭包仅捕获 `opts`，策略在 step 内解析，无异常。
