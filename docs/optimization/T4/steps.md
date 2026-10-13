# T4 执行步骤（原子化）

> 配套 `plan.md`。每步为对 `retry.ts` 的局部编辑，**不改语义**（仅重排/抽取），最后一步整体静态核对。
> 全程：仅 `retry.ts` 单文件、无新依赖、TS 风格与现有 import/命名一致。

---

## 步骤 0：基线快照（不改码）
- **操作**：记录现有导出与常量引用位置。
- **产物**：基线清单（导出行 + `RETRY_*` 常量 + `RETRYABLE_MESSAGE_PATTERNS` 使用点）。
- **静态核对**：
  - grep `export` 得到：`delay` / `retryable` / `policy` / `GO_UPSELL_MESSAGE` / `GO_UPSELL_URL` / `SessionRetry`。
  - grep `RETRY_INITIAL_DELAY|RETRY_BACKOFF_FACTOR|RETRY_JITTER_FACTOR|RETRY_MAX_DELAY_NO_HEADERS|RETRY_MAX_DELAY|RETRY_MAX_RETRIES|RETRYABLE_MESSAGE_PATTERNS` 确认当前引用点（L27–L31、L33–L41、L44、L64、L73、L77、L81、L193）。

## 步骤 1：新增 `RetryPolicy` 类型与 `DEFAULT_RETRY_POLICY` 常量（仅新增）
- **操作**：
  1. 在 import 之后、既有常量附近新增 `RetryPolicy` 类型（plan §3.1）。
  2. 新增模块级 `DEFAULT_RETRY_POLICY`（plan §3.2），值取自既有 `RETRY_*` 与 `RETRYABLE_MESSAGE_PATTERNS`。
- **预期产物**：文件新增「一个类型 + 一个常量」，原 L1–L209 逻辑未动。
- **静态核对**：
  - grep 确认 `RETRY_INITIAL_DELAY` 等仍被 `DEFAULT_RETRY_POLICY` 引用（值未丢）。
  - `RETRYABLE_MESSAGE_PATTERNS` 仍被 `DEFAULT_RETRY_POLICY.retryable.messagePatterns` 引用。

## 步骤 2：将 upsell 硬编码块封装为 `specialCases` 拦截器（逻辑平移）
- **操作**：
  1. 新增 `freeTierUpsell(input)`：平移原 L99–L111，入参取 `input.error` / `input.provider`，返回 `Retryable`（含 `action`）。
  2. 新增 `goLimitUpsell(input)`：平移原 L112–L144，复用既有 `parseJSON` / `str` / `num` / `iife` / `GO_UPSELL_*`。
  3. 顺序保持：先 freeTier 后 goLimit（与原 if 链一致）。
- **预期产物**：两个纯函数；原 L99–L144 在 `retryable` 中**暂未删除**（下一 B 步替换）。
- **静态核对**：
  - grep 确认 `FreeUsageLimitError` / `GoUsageLimitError` 同时出现在原函数与 `specialCases` 引用处（迁移完整）。
  - 确认 `parseJSON` / `str` / `num` / `iife` 仍被引用（无孤立函数）。

## 步骤 3：改造 `exponential` / `cap` / `delay` 消费策略（plan §3.4）
- **操作**：
  1. `exponential(attempt, random, policy = DEFAULT_RETRY_POLICY)` 改用 `policy.backoff`。
  2. `cap(ms, maxDelay = RETRY_MAX_DELAY)` 新增可选 `maxDelay` 参数（默认沿用全局）。
  3. `delay(attempt, error?, random = Math.random(), policy = DEFAULT_RETRY_POLICY)`：头名取自 `policy.rateLimit`；无头截断用 `policy.backoff.maxDelayNoHeaders`；最终 `cap` 用 `policy.backoff.maxDelay`。
- **预期产物**：`delay` / `exponential` 签名末尾新增可选 `policy` 参数，既有 2/3 参调用仍有效。
- **静态核对**：
  - grep `delay(` 现有调用处参数个数未变（追加尾部参数不影响既有调用）。
  - **语义走查**：默认 `policy` 下，代入 `DEFAULT_RETRY_POLICY` 值复算 L47–L78，分支与数值与改造前逐行一致（含 `retry-after-ms` / `retry-after` / 无头 `30_000` 截断 / `cap`）。

## 步骤 4：改造 `retryable` 消费策略 + 串联 specialCases（plan §3.4）
- **操作**：
  1. `retryable(error, provider, policy = DEFAULT_RETRY_POLICY)`。
  2. APIError 分支：5xx 强制重试改读 `policy.retryable.retry5xx`；`matchesRetryableMessage` 改读 `policy.retryable.messagePatterns`。
  3. 删除原 L99–L144 内联块，改为：算出 `base` Retryable 后，依次执行 `policy.specialCases` 取首个非 `undefined` 结果。
  4. 非 APIError 分支的 `matchesRetryableMessage(message)` 同样改读 `policy.retryable.messagePatterns`。
- **预期产物**：`retryable` 不再含 upsell 内联逻辑，逻辑等价下沉到 specialCases。
- **静态核对**：
  - before/after 走查：`FreeUsageLimitError` 输入，原返回结构 == `freeTierUpsell` 返回结构（字段逐一比对）；`GoUsageLimitError` 同理。
  - `matchesRetryableMessage` 现接收 policy 参数，grep 所有调用处均已传入 `policy.retryable.messagePatterns`。

## 步骤 5：新增 `RETRY_POLICIES` 注册表与 `selectPolicy`（plan §3.3）
- **操作**：
  1. 模块级 `const RETRY_POLICIES: Record<string, RetryPolicy> = {}`。
  2. 导出 `selectPolicy(provider)`：`return RETRY_POLICIES[provider] ?? DEFAULT_RETRY_POLICY`。
- **预期产物**：扩展点就位；默认表为空 ⇒ 行为不变。
- **静态核对**：`selectPolicy("any")` 在无注册时恒等于 `DEFAULT_RETRY_POLICY`（grep 确认表为空、无写入分支）。

## 步骤 6：改造 `policy()`（核心循环）消费策略（plan §3.4）
- **操作**：
  1. `policy(opts)` 首行 `const rp = selectPolicy(opts.provider)`。
  2. `retryable(error, opts.provider, rp)` 替换原 `retryable(error, opts.provider)`。
  3. `delay(meta.attempt, apiErrOrUndef, random, rp)` 替换原调用（`random` 位置不变）。
  4. `meta.attempt > rp.maxRetries` 替换 `RETRY_MAX_RETRIES`（L193）。
- **预期产物**：核心循环完全经策略驱动。
- **静态核对**：
  - grep 确认 `RETRY_MAX_RETRIES` 仍作为 `DEFAULT_RETRY_POLICY.maxRetries` 取值（全局常量保留）。
  - `Schedule.fromStepWithMetadata` 调用结构与返回类型未变。

## 步骤 7：整体静态核对与 before/after 报告（验收 5）
- **产物**：本步骤末附 before/after 对照小节 + 走查结论（写入本文件）。
- **核对清单**：
  1. **导出清单不变**：grep `export` 行与步骤 0 基线一致；新增仅为 `RetryPolicy` 类型、`DEFAULT_RETRY_POLICY`、`selectPolicy`。
  2. **默认等价走查（关键）**：代入 `DEFAULT_RETRY_POLICY` 手工复算代表样本，逐项与原 L47–L207 输出一致：
     - 5xx（`status=503`, `isRetryable=false`）→ 仍 retryable（`retry5xx=true`）。
     - `429` + `retry-after` 头 → `delay` 解析头值（头名来自 policy）。
     - `FreeUsageLimitError` body → 返回固定 upsell（`specialCases[0]`）。
     - `GoUsageLimitError` body → 返回重置文案（`specialCases[1]`）。
     - 普通超时 message → 命中 `messagePatterns`（原 `RETRYABLE_MESSAGE_PATTERNS`）。
     - `attempt > 5` → `Cause.done`。
  3. **单文件 / 无依赖**：grep 确认无新增 `import` 行（仅既有 import，可选重排），无外部包引用。
  4. **TS 风格一致**：新增类型与既有 `Err` / `Retryable` 风格一致；新增常量沿用 UPPER_CASE。
- **before/after 摘要**：
  - **Before**：退避/重试/限流/upsell 全部硬编码于全局常量与 `retryable` / `delay` 内联分支。
  - **After**：以上全部声明于 `DEFAULT_RETRY_POLICY`，核心循环经 `selectPolicy` 取策略；新增 provider 仅需 `RETRY_POLICIES[provider] = ...`。
  - **默认路径行为**：逐项等价（见核对 2）。
