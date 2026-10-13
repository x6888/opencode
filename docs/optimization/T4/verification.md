# T4 验证报告（验证者 / 流程 4.4）

> 验证对象：`packages/opencode/src/session/retry.ts`（改后，307 行）
> 配套：plan.md / steps.md / implementation.md
> 方法：**仅静态/结构核对**（无 build / 无 run），以代码行与 implementation 走查为证据。
> 文件改动范围：单文件 `retry.ts`，无新增 `import`、无新依赖。

---

## 逐条验收核对

### 标准 1：抽出"重试策略"为可配置结构（退避基数、最大重试、可重试规则、限流头解析、provider upsell 等），可扩展
**结论：✅ PASS**

证据：
- `RetryPolicy` 类型定义 `retry.ts:50-76`，覆盖全部维度：
  - 退避基数：`backoff{initialDelay, factor, jitter, maxDelay, maxDelayNoHeaders}`（L53-59）
  - 最大重试：`maxRetries`（L52）
  - 可重试规则：`retryable{retry5xx?, statusCodes?, messagePatterns}`（L60-64）
  - 限流头解析：`rateLimit?{retryAfterMsHeaders, retryAfterHeaders}`（L65-68）
  - provider upsell：`specialCases?`（拦截器数组，L71-75）
- 可扩展性落点：模块级注册表 `const RETRY_POLICIES: Record<string, RetryPolicy> = {}`（L156）+ 导出函数 `selectPolicy(provider)`（L158-160）。新增 provider 只需注册一条 `RetryPolicy`，核心循环无需改动（L156 注释明确"扩展点"）。

### 标准 2：核心 retry 循环复用该策略，不再硬编码特定 provider；默认策略与原行为等价（向后兼容）
**结论：✅ PASS**

证据：
- 核心循环 `policy(opts)` `retry.ts:283-304`：首行 `const rp = selectPolicy(opts.provider)`（L286），随后 `retryable(error, opts.provider, rp)`（L288）、`delay(..., rp)`（L292）、`meta.attempt > rp.maxRetries`（L290）均消费 `rp`，无特定 provider 硬编码。
- 默认等价走查（代入 `DEFAULT_RETRY_POLICY`，值来自原 `RETRY_*` 常量与 `RETRYABLE_MESSAGE_PATTERNS`）：
  - `exponential`：新 L210-213 `initialDelay * factor^(attempt-1)` + `ceil(base + base*jitter*random)` ⟷ 原 `RETRY_INITIAL_DELAY/RETRY_BACKOFF_FACTOR/RETRY_JITTER_FACTOR` → 数值同。
  - `delay` 限流头：新 L175-176 取 `policy.rateLimit` 默认 `["retry-after-ms"]`/`["retry-after"]` ⟷ 原硬编码两头名；`cap(ms, maxDelay=policy.backoff.maxDelay)`（L181/191/196/200）⟵ 原 `cap` 默认 `RETRY_MAX_DELAY`；无头分支 L204-207 `cap(min(exp, maxDelayNoHeaders), maxDelay)` ⟵ 原 `cap(min(exp, RETRY_MAX_DELAY_NO_HEADERS))`（`30000 < maxDelay` 外层 cap 恒等） → 等价。
  - `retryable` 5xx 强重试：新 L225 `((policy.retryable.retry5xx ?? true) && status !== undefined && status >= 500)`，`retry5xx=true` ⟵ 原 `status >= 500`；`statusCodes` 默认 `undefined` → `false` 不影响；`messagePatterns` 默认 `RETRYABLE_MESSAGE_PATTERNS`（L227/228） → 等价。
  - upsell：`specialCases=[freeTierUpsell, goLimitUpsell]`（L151），顺序 freeTier→goLimit 与原 if 链一致；二者纯函数平移原 L99-L144（`freeTierUpsell` L80-94、`goLimitUpsell` L96-130）。
  - `meta.attempt > rp.maxRetries`（=5）⟵ 原 `RETRY_MAX_RETRIES` 截断 → 等价。

### 标准 3：改动仅限 `retry.ts` 单文件、无新依赖、TS 风格一致
**结论：✅ PASS**

证据：
- 单文件：本验证仅读取 `retry.ts`，所有新增类型/常量/函数（`RetryPolicy`、`DEFAULT_RETRY_POLICY`、`RETRY_POLICIES`、`selectPolicy`、`freeTierUpsell`、`goLimitUpsell`、`cap`/`exponential`/`delay`/`retryable`/`policy` 改造）均位于该文件内。
- 无新依赖：文件 import 区 `retry.ts:1-6` 与基线（plan 步骤 0）完全一致，无新增 `import` 行；新增辅助函数 `str/num/parseJSON`（L256-276）复用既有 `iife`（L5）/ `isRecord`（L6），未引入外部包。
- TS 风格一致：新增 `RetryPolicy`/`Retryable` 为 `export type` 与既有 `Err`/`Retryable` 风格一致；常量沿用 `UPPER_CASE`，函数沿用 `camelCase`；`specialCases` 拦截器签名与 `Retryable` 类型自洽。

### 标准 4：保留现有导出与调用方语义（重试结果/异常行为兼容）
**结论：✅ PASS**

证据：
- 导出清单（grep `export`）：保留 `delay`（L166）、`retryable`（L215）、`policy`（L278）、`GO_UPSELL_MESSAGE`（L10）、`GO_UPSELL_URL`（L11）、`SessionRetry`（L306）、`Retryable`（L14）、`Err`（L8）；新增导出 `RetryPolicy`（类型，L50）、`DEFAULT_RETRY_POLICY`（L133）、`selectPolicy`（L158）。
- 调用方兼容：`delay`/`retryable`/`exponential` 仅在**尾部追加可选 `policy` 参数且默认 `DEFAULT_RETRY_POLICY`**（L170/L210/L215），既有 2/3 参调用签名不变；`policy`/`SessionRetry` 签名与导出形态未变 → 调用方零改动。
- 异常/结果语义：`ContextOverflowError` 仍直接 `undefined`（L217，与原一致）；`Cause.done(meta.attempt)` 返回语义不变（L289/L290）；`Retryable` 结构（message/action）字段语义保留。

### 标准 5：附 before/after 行为说明与最小静态核对（implementation.md 中应有，且含"默认等价原行为"走查）
**结论：✅ PASS**

证据：
- `implementation.md` 第二节 diff 摘要、第三节"Before/After 对照 + 等价性逐项核对表"（含 8 类输入样本：503/429+头/无头限流/FreeUsageLimitError/GoUsageLimitError/普通超时/attempt>5），明确标注"默认策略与原行为完全等价"。
- `steps.md` 步骤 7 静态核对清单含"默认等价走查（关键）"逐项 ✅。
- 本验证报告标准 2 已独立复算关键路径，与 implementation 走查一致。

---

## 优化闭环判定

**达成。**

五项验收标准全部 PASS，且证据均来自改后 `retry.ts` 实际代码行与 implementation.md 走查；默认路径行为经静态复算与原行为等价，向后兼容与调用方语义均保留，单文件/零依赖/TS 风格约束满足。

---

## 备注（非阻塞，供参考）
- 扩展点 `RETRY_POLICIES` 当前为空表（L156），即"默认全走默认"；后续如需按 provider 覆盖，仅需在该表注册，无需触碰核心循环（已实现可扩展骨架）。
- 未执行 build/run（环境约束），等价性为静态走查结论；如需更强置信，建议在可运行环境补一组针对 `retryable`/`delay` 的单元测试（断言 8 类样本输入输出），但非本闭环必需项。
