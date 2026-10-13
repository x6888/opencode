# T5 实现说明：外部插件加载超时隔离（`plugin/loader.ts`）

> 改码者交付物（流程 4.3）。仅修改 `packages/opencode/src/plugin/loader.ts` 单文件。
> 无新 npm 依赖，保持现有 import 与 TS 风格，未破坏导出与调用方语义。

---

## 1. 改动摘要（关键 diff）

### 1.1 新增超时阈值常量 + 哨兵（模块级，命名空间内）
位置：`AttemptResult` 类型之后（loader.ts:59-66）。

```ts
// T5: 单插件外部加载超时阈值（毫秒）。一个插件加载超过该时间即被隔离，
// 不阻塞同批次其他插件与 loadExternal 整体返回。可按需调整。
// 可选覆盖：通过环境变量 OPENCODE_PLUGIN_LOAD_TIMEOUT_MS 设置（无新依赖，仅用运行时内置 process/Number）。
const EXTERNAL_PLUGIN_LOAD_TIMEOUT_MS =
  Number(process.env.OPENCODE_PLUGIN_LOAD_TIMEOUT_MS) || 30_000

// 用于区分"超时"与"真实错误"的内部哨兵，避免误把真实 reject 当成超时处理。
const PLUGIN_LOAD_TIMEOUT = Symbol("plugin-load-timeout")
```

### 1.2 扩展 `Report` 类型（可选字段，向后兼容）
位置：`Report` 类型体内、`error?` 字段之后（loader.ts:50-51）。既有 `start/missing/error` 字段一字未改。

```ts
// T5: 单个外部插件加载超时时回调，便于上层记录/观测被隔离的插件。
timeout?: (candidate: Candidate, retry: boolean, message: string) => void
```

### 1.3 新增 `withExternalTimeout` 辅助函数（隔离核心）
位置：`load` 之后、`attempt` 之前（loader.ts:150-185）。复用既有 `Candidate`/`AttemptResult`/`Report` 类型，仅用运行期内置 `Promise`/`setTimeout`/`Symbol`/`clearTimeout`。

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

### 1.4 包裹初始加载列表（loadExternal 内 for 循环）
位置：loader.ts:251-260。原 `list.push(attempt(...))` 改为 `list.push(withExternalTimeout(attempt(...), candidate, false, input.report))`。

### 1.5 包裹重试路径（wait 循环内）
位置：loader.ts:275-280。原 `out[i] = await attempt(...)` 改为 `out[i] = await withExternalTimeout(attempt(...), candidate, true, input.report)`。

---

## 2. 未改动项（保持 zero-intrusion）
- import 块（loader.ts:1-13）：未新增任何 import。
- `loadExternal` 函数签名与导出（loader.ts:248）：不变。
- `resolve` / `load` / `attempt` 的 `export` 与参数：不变。
- `ready` 过滤（loader.ts:285-287，仅保留 `value !== undefined`）：不变，天然作为"隔离即丢弃"落点。
- 其余所有逻辑（`Promise.all`、wait 循环结构、retry 判定）：逐行等同基线。

---

## 3. before / after 行为对照

**Before**：某外部插件 A 卡死（如 `resolvePluginTarget` 阻塞或动态 `import` hang），
`Promise.all(list)`（loader.ts:261）一直等待 A；同批次 B/C 虽已算完，但 `loadExternal` 不返回，
调用方整体阻塞；无任何单插件隔离。

**After**：
- A 被 `withExternalTimeout` 包裹，30s（或 `OPENCODE_PLUGIN_LOAD_TIMEOUT_MS`）后 `race` 以
  `PLUGIN_LOAD_TIMEOUT` 哨兵 reject → `.catch` 识别 → `report.timeout?.(A,...)` 记录 →
  返回 `{ value: undefined, retry: false }`（**已 settled**，不拖 `Promise.all`）。
- B/C 各自独立 `race`，正常结果保留。
- `Promise.all` 在 ≤阈值内全部 settle → `ready` 过滤丢弃 A，保留 B/C。
- 整体加载在**有界时间**内完成；成功路径（无超时）与改造前逐字节一致。

**真实错误语义**：`attempt` 的真实 reject（非超时）在 `.catch` 中 `throw err`，保留既有"整批 reject"行为，不静默吞错。

---

## 4. 关键语义注释（避免误导）
在 `withExternalTimeout` 注释中明确（loader.ts:152-157）：
`Promise.race` 仅"停止等待"该插件，并不真正取消底层工作
（`resolvePluginTarget` / 动态 `import` 不接受 `AbortSignal`）。超时目标是**隔离阻塞**而非取消：
底层请求仍可能在后台继续占用资源，但本插件不会拖垮 `Promise.all` 与 `loadExternal` 整体返回。

---

## 5. 静态核对（无法 build/run，替代方式）
1. import 块无新增（`loader.ts:1-13`）—— 通过 Read 确认。
2. `EXTERNAL_PLUGIN_LOAD_TIMEOUT_MS` 仅声明一次（`Grep` 命中 loader.ts:62/66/178）—— 唯一定义。
3. `Report.timeout` 为可选字段（`?`，loader.ts:51），既有 `start/missing/error` 未改。
4. 两处包裹到位：`list.push` → `withExternalTimeout(attempt(...)`（loader.ts:252-259）；
   `out[i] = await` → `withExternalTimeout(attempt(...)`（loader.ts:275-280）。
5. `withExternalTimeout` 返回 `Promise<AttemptResult<R>>`；超时分支返回 `AttemptResult`，真实错误 `throw err`。
6. `loadExternal` 导出/签名不变（`export async function loadExternal<R = Loaded>(...)`）。
7. `ready` 过滤未动（loader.ts:285-287）。

**单插件超时不影响其他走查**：插件 A（卡死）/B（快，2s）。
`list = [race(attemptA,30s), race(attemptB,30s)]`。B 在 2s 正常 resolve → `out[1]` 保留。
A 在 30s 触发 timeout → 隔离结果 `out[0]={value:undefined,retry:false}`（已 settled）。
`Promise.all` 在 30s 全部 settle → `ready` 丢弃 `out[0]`、保留 `out[1]`。
结论：A 超时仅导致自身被丢弃与记录，B 结果与时序完全不受影响，整体 ≤30s 有界返回。✅

---

## 6. 与 plan 的冲突检查
- 未发现冲突。plan 全部 5 项建议（常量、Report 可选字段、withExternalTimeout、两处包裹、R1 语义注释）
  均已按设计实现；plan 的"可选 process.env 覆盖"在步骤.md 标记为可选，本实现一并纳入常量定义（安全、无新依赖），
  与 plan 默认行为一致（未设置 env 时即 30_000ms）。
- 所有改动自包含于 `loader.ts` 单文件，未引入新依赖，成功加载路径与导出签名无变化。

---

## 7. 回退
删除 loader.ts 中：常量（`EXTERNAL_PLUGIN_LOAD_TIMEOUT_MS`/`PLUGIN_LOAD_TIMEOUT`）、
`Report.timeout` 字段、`withExternalTimeout` 函数；并把两处 `list.push`/`out[i]=` 还原为直接 `attempt(...)`
调用，即 100% 回到基线（单文件，可 sandbox 副本比对）。
