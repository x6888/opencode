# T5 优化计划：外部插件加载超时隔离（`plugin/loader.ts`）

> 规划者交付物（流程 4.2）。**仅规划，不改代码。**
> 工作副本：`d:/python_work/agent_work/code_buddy_work/sandbox/opencode/`
> 目标文件：`packages/opencode/src/plugin/loader.ts`
> 约束：改动自包含于 `loader.ts` 单文件，无新依赖，TS 风格与现有 import/命名一致。

---

## 1. 优化目标

为 `loadExternal` 加载外部插件引入**单插件加载超时隔离**机制：

- 每个外部插件的加载（resolve + load）受一个可预期的超时阈值约束；
- 单个插件卡死/超时时，仅隔离该插件（跳过、不重试、记录），**不阻塞**同批次其他插件，也不阻塞 `loadExternal` 整体返回；
- 默认不破坏现有正常加载路径与导出/调用方语义。

---

## 2. 当前实现分析（基于最新源码）

外部插件加载主链路位于 `loadExternal`（`loader.ts:200-228`）：

1. `loader.ts:201` 把每个配置项归一化为 `candidate = { origin, plan }`；
2. `loader.ts:203-205` 遍历 `candidates`，对每个调用 `attempt(...)` 并 push 进 `list`（`Promise<AttemptResult<R>>[]`）；
3. `loader.ts:206` `const out = await Promise.all(list)` —— **所有插件并发加载，整体等待直至全部 settle**；
4. `loader.ts:207-222` 若存在 `input.wait`，对 `retry === true` 的 file 插件再 `attempt` 一次（`loader.ts:220`）；
5. `loader.ts:225-227` 过滤 `out`，仅保留 `value !== undefined` 的结果，按原顺序返回 `ready: R[]`。

`attempt`（`loader.ts:141-184`）内部串行调用：
- `resolve(plan, kind)`（`loader.ts:78-125`）：含 `resolvePluginTarget`（首次可能触发 npm 安装，`loader.ts:89`）、`createPluginEntry`（`loader.ts:98`）、npm 插件的 `checkPluginCompatibility`（`loader.ts:119`）；
- `load(resolved.value)`（`loader.ts:128-137`）：动态 `import(row.entry)`（`loader.ts:131`）。

**关键缺口**：
- `attempt` / `resolve` / `load` 均**不接受 `AbortSignal`**，底层 npm 安装与动态 `import` 无法被真正取消；
- `Promise.all(list)` 整体等待最慢/卡死的插件，单插件 hang 会拖垮整批返回；
- 没有任何超时或隔离逻辑，超时/卡死只能靠底层 promise 自行 settle（可能永不）。

> 现有的 `ready` 过滤（`loader.ts:226` 仅保留 `value !== undefined`）天然提供了"隔离即丢弃"的落点，是本次改造的安全承载点。

---

## 3. 优化方案

### 3.1 总体策略

采用 **`Promise.race([attempt, timeout])`** 包裹每个 `attempt`，而非依赖 `AbortController` 取消底层工作（底层不支持 signal）。超时时：
- 调用新增的 `report.timeout?.(...)` 记录；
- 返回隔离结果 `{ value: undefined, retry: false }`（非 reject），使 `Promise.all` 不被拖垮、`ready` 过滤自动丢弃该插件；
- **真实错误**（非超时的 reject）原样向上抛出，保留 `loadExternal` 现有"attempt 抛错则整批 reject"的既有行为，避免改变正常失败语义。

### 3.2 超时常量（模块级，自包含默认）

在 `PluginLoader` 命名空间内新增：

```ts
// T5: 单插件外部加载超时阈值（毫秒）。一个插件加载超过该时间即被隔离，
// 不阻塞同批次其他插件与 loadExternal 整体返回。可按需调整（见 steps 可选步骤）。
const EXTERNAL_PLUGIN_LOAD_TIMEOUT_MS = 30000

// 用于区分"超时"与"真实错误"的内部哨兵，避免误把真实 reject 当成超时处理。
const PLUGIN_LOAD_TIMEOUT = Symbol("plugin-load-timeout")
```

### 3.3 新增隔离辅助函数（命名空间内，复用现有类型）

```ts
function withExternalTimeout<R>(
  run: Promise<AttemptResult<R>>,
  candidate: Candidate,
  retry: boolean,
  report: Report | undefined,
): Promise<AttemptResult<R>> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(PLUGIN_LOAD_TIMEOUT), EXTERNAL_PLUGIN_LOAD_TIMEOUT_MS)
  })
  return Promise.race([run, timeout])
    .finally(() => {
      if (timer) clearTimeout(timer)
    })
    .catch((err) => {
      if (err === PLUGIN_LOAD_TIMEOUT) {
        // 仅超时走隔离分支：记录 + 丢弃 + 不重试。
        report?.timeout?.(
          candidate,
          retry,
          `plugin ${candidate.plan.spec} load timed out after ${EXTERNAL_PLUGIN_LOAD_TIMEOUT_MS}ms`,
        )
        return { value: undefined, retry: false } as AttemptResult<R>
      }
      // 真实错误原样抛出，保留既有行为（不误判为超时）。
      throw err
    })
}
```

### 3.4 扩展 `Report` 类型（可选字段，向后兼容）

在 `loader.ts:37-50` 的 `Report` 类型中追加一个**可选**回调（不改动既有字段，调用方无感知）：

```ts
// 单个外部插件加载超时时回调，便于上层记录/观测被隔离的插件。
timeout?: (candidate: Candidate, retry: boolean, message: string) => void
```

> 不修改 `error` 回调的 `stage` 联合类型（避免破坏调用方对 `"install"|"entry"|"compatibility"|"load"` 的穷举匹配），超时单独走 `timeout` 通道。

### 3.5 改造 `loadExternal`（仅两处包裹）

- `loader.ts:204`（初始加载列表）：
  ```ts
  list.push(
    withExternalTimeout(
      attempt(candidate, input.kind, false, input.finish, input.missing, input.report),
      candidate,
      false,
      input.report,
    ),
  )
  ```
- `loader.ts:220`（retry 重试路径，保持隔离一致性）：
  ```ts
  out[i] = await withExternalTimeout(
    attempt(candidate, input.kind, true, input.finish, input.missing, input.report),
    candidate,
    true,
    input.report,
  )
  ```

其余代码（`Promise.all`、wait 循环、`ready` 过滤、导出）**全部不动**。

### 3.6 before / after 行为对照

**Before**：插件 A 卡死（如 `resolvePluginTarget` 阻塞或 `import` hang），`Promise.all(list)`（`loader.ts:206`）一直等待 A；同批次 B/C 虽已算完结果，但 `loadExternal` 不返回，调用方整体阻塞；无单插件隔离。

**After**：A 被 `withExternalTimeout` 包裹，30s 后 `race` 以 `PLUGIN_LOAD_TIMEOUT` 拒绝 → 捕获 → `report.timeout` 记录 → 返回 `{value:undefined, retry:false}`（已 settle，不拖 `Promise.all`）→ `ready` 过滤（`loader.ts:226`）丢弃 A。B/C 各自独立 race，正常结果保留并随 `Promise.all` 在 ≤30s 内全部 settle 后返回。整体加载在**有界时间**内完成。成功路径（无超时）与改造前逐字节一致。

---

## 4. 预期收益

- **可用性**：单插件卡死不再拖垮整批外部插件加载，`loadExternal` 返回时间有上界。
- **可预期**：超时阈值=常量，超时行为=隔离+记录，确定性强。
- **零侵入**：仅 `loader.ts` 单文件；无新依赖；导出/调用方语义保持；正常加载路径不变。
- **可观测**：通过 `report.timeout` 回调，上层可清晰知道哪些插件被隔离。

---

## 5. 风险与回退

| 风险 | 说明 | 缓解 / 回退 |
|---|---|---|
| **R1 `AbortController` 不被底层支持** | `resolvePluginTarget`/`import` 不接受 `AbortSignal`，`Promise.race` 只能"不再等待"，底层请求仍可能在后台继续占用资源（不真正取消）。 | 接受：T5 目标是**隔离阻塞**，而非取消底层工作；在注释中明确该语义。后续若底层支持 signal，可在 `withExternalTimeout` 内扩展传入 `AbortSignal`（可选增强）。 |
| **R2 超时默认值取值** | 30s 对"首次慢速 npm 安装"可能误伤正常插件；过大则隔离形同虚设。 | 阈值抽为模块级常量 `EXTERNAL_PLUGIN_LOAD_TIMEOUT_MS`，集中可调；可选增加 `process.env.OPENCODE_PLUGIN_LOAD_TIMEOUT_MS` 覆盖（无新依赖，见 steps 可选步骤）。回退：单文件还原 `loader.ts` 即可，因未改动其他文件。 |
| **R3 误吞真实错误** | 若将 `attempt` 的真实 reject 也当成超时隔离，会静默吞错。 | `catch` 中仅当 `err === PLUGIN_LOAD_TIMEOUT` 才走隔离；真实错误 `throw err` 保留既有整批 reject 行为。 |

**回退方案**：本改动完全自包含于 `loader.ts`，删除新增的常量、`Report.timeout` 字段、`withExternalTimeout` 函数，并把两处 `list.push`/`out[i]=` 还原为直接 `attempt(...)` 调用，即可 100% 回到现状（可借助 git/sandbox 副本比对）。

---

## 6. 验收标准逐条对照表

| # | 主 Agent 验收标准 | 本方案对应落点 | 是否满足 |
|---|---|---|---|
| 1 | 引入超时机制（per-plugin load timeout 常量），超阈值中断该插件加载 | 常量 `EXTERNAL_PLUGIN_LOAD_TIMEOUT_MS` + `withExternalTimeout` 以 `Promise.race` 包裹单插件 `attempt`，超时即停止等待并隔离 | ✅ |
| 2 | 超时/失败仅影响该插件，不阻塞其他插件与整体流程；行为可预期 | 超时返回 `{value:undefined, retry:false}`，`Promise.all` 不卡、其他插件各自独立 race、`ready` 过滤自动丢弃；触发即记录 | ✅ |
| 3 | 仅限 `loader.ts` 单文件、无新依赖、TS 风格与 import/命名一致 | 仅改本文件：新增常量/函数/`Report` 可选字段；复用 `Candidate`/`AttemptResult`/`Report`；无新增 import | ✅ |
| 4 | 保留现有导出与调用方语义，成功路径与原行为兼容 | `loadExternal` 签名不变、导出不变；成功路径无超时 → 与现状逐字节一致；真实错误仍按原行为 reject | ✅ |
| 5 | 附 before/after 说明与最小静态核对（含"单插件超时不影响其他"走查） | 见 §3.6 before/after 与 §7 静态核对（含单插件超时走查） | ✅ |

---

## 7. 最小静态核对方式（无法 build/run）

> 仅用 grep / 文件通读 / 逻辑走查，不执行编译。

1. **无新依赖**：`Read loader.ts` 顶部 import 块（`loader.ts:1-13`），确认未新增任何 `import`。
2. **常量定义唯一**：`Grep "EXTERNAL_PLUGIN_LOAD_TIMEOUT_MS"` 应仅在常量声明处定义一次，且在两处 `withExternalTimeout` 调用中均被使用。
3. **Report 向后兼容**：`Grep "timeout\?:"` 确认 `Report.timeout` 为可选字段（`?`），既有 `start/missing/error` 字段未改动。
4. **两处包裹到位**：
   - `Grep "list.push"` 应指向 `withExternalTimeout(attempt(...)`；
   - `Grep "out\[i\] = await"` 应指向 `withExternalTimeout(attempt(...)`。
5. **返回类型一致**：`withExternalTimeout` 返回 `Promise<AttemptResult<R>>`，成功/超时均返回 `AttemptResult`，真实错误 `throw`（与原 `attempt` 返回类型一致）。
6. **导出/签名不变**：`Grep "export async function loadExternal"` 签名与现状一致；`resolve`/`load`/`attempt` 的 `export` 与参数未变。
7. **`ready` 过滤未动**：`Read loader.ts:225-227` 确认仍是"仅保留 `value !== undefined`"，超时结果自然被丢弃，无需额外改动。

### 单插件超时不影响其他的走查（核心）

- 设插件 A（慢/卡死）、B（快，2s）。
- `loadExternal` 中 `list = [race(attemptA, 30s), race(attemptB, 30s)]`。
- B 在 2s 正常 resolve → `out[1] = {value: B, retry:false}`。
- A 在 30s 触发 timeout → `race` 以哨兵 reject → `catch` 识别 → `report.timeout(A)` + 返回 `{value:undefined, retry:false}` → `out[0]` 为该隔离结果（**已 settled**，不再阻塞 `Promise.all`）。
- `Promise.all` 在 30s 全部 settle → `ready` 过滤丢弃 `out[0]`，保留 `out[1]=B`。
- 结论：A 超时**仅**导致其自身被丢弃与记录，B 的结果与返回时序完全不受影响，整体在 ≤30s 内有界返回。✅
