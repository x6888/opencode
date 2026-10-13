# T5 执行步骤：外部插件加载超时隔离（`plugin/loader.ts`）

> 原子步骤清单。每步标注**预期产物**与**静态核对方法**。规划用，不改代码。
> 目标文件：`packages/opencode/src/plugin/loader.ts`（工作副本）
> 原则：改动自包含于单文件、无新依赖、不破坏导出/调用方语义。

---

## 步骤 0（前置）— 锁定基线
- **动作**：`Read loader.ts` 全量，确认 `loadExternal`（`200-228`）、`attempt`（`141-184`）、`Report`（`37-50`）当前内容，作为 diff 基线。
- **预期产物**：清晰的"改前"快照，便于回退比对。
- **静态核对**：记录关键行号；确认未在任何其他文件出现相关逻辑（确认单文件约束）。

---

## 步骤 1 — 新增超时阈值常量与哨兵
- **位置**：`PluginLoader` 命名空间内，建议在 `type AttemptResult`（`loader.ts:52`）之前或现有类型之后。
- **改动**：
  ```ts
  const EXTERNAL_PLUGIN_LOAD_TIMEOUT_MS = 30000
  const PLUGIN_LOAD_TIMEOUT = Symbol("plugin-load-timeout")
  ```
- **预期产物**：模块级常量定义（默认 30s），无新增 import。
- **静态核对**：`Grep "EXTERNAL_PLUGIN_LOAD_TIMEOUT_MS"`，确认仅此处定义一次；确认 import 块（`loader.ts:1-13`）无新增行。

---

## 步骤 2 — 扩展 `Report` 类型（可选字段）
- **位置**：`loader.ts:37-50` 的 `Report` 类型，紧接 `error?` 字段之后。
- **改动**：
  ```ts
  timeout?: (candidate: Candidate, retry: boolean, message: string) => void
  ```
- **预期产物**：`Report` 新增可选回调；既有 `start/missing/error` 字段一字未改。
- **静态核对**：`Grep "timeout\?:"` 命中且带 `?`；`Grep "export type Report"`/类型体确认其他字段签名未变。

---

## 步骤 3 — 新增 `withExternalTimeout` 辅助函数
- **位置**：命名空间内，建议放在 `attempt`（`loader.ts:141`）之前或之后，复用 `Candidate`/`AttemptResult`/`Report`。
- **改动**：实现见 `plan.md §3.3`（要点：`Promise.race([run, timeout])` + `setTimeout` 触发哨兵 + `.finally` 清 timer + `.catch` 仅当 `err === PLUGIN_LOAD_TIMEOUT` 时返回 `{value:undefined, retry:false}` 并调用 `report.timeout?.()`，否则 `throw err`）。
- **预期产物**：返回 `Promise<AttemptResult<R>>` 的函数，成功/超时返回 `AttemptResult`，真实错误向上抛。
- **静态核对**：
  - `Grep "function withExternalTimeout"` 命中；
  - 确认函数体未引入新 import（仅用已有类型与 `setTimeout`/`Promise`/`Symbol` 等运行期内置）；
  - 确认超时分支返回 `{ value: undefined, retry: false }`，真实错误分支 `throw err`。

---

## 步骤 4 — 包裹初始加载列表（`loader.ts:204`）
- **位置**：`loadExternal` 的 `for` 循环内 `list.push(attempt(...))`。
- **改动**：改为
  ```ts
  list.push(
    withExternalTimeout(
      attempt(candidate, input.kind, false, input.finish, input.missing, input.report),
      candidate, false, input.report,
    ),
  )
  ```
- **预期产物**：初始加载的每个 `attempt` 均经超时隔离。
- **静态核对**：`Grep "list.push"` 指向 `withExternalTimeout(attempt(...)`；参数 `(candidate, false, input.report)` 完整。

---

## 步骤 5 — 包裹重试路径（`loader.ts:220`）
- **位置**：`wait` 循环内的 `out[i] = await attempt(...)`。
- **改动**：改为
  ```ts
  out[i] = await withExternalTimeout(
    attempt(candidate, input.kind, true, input.finish, input.missing, input.report),
    candidate, true, input.report,
  )
  ```
- **预期产物**：retry 路径同样受超时约束，隔离语义一致。
- **静态核对**：`Grep "out\[i\] = await"` 指向 `withExternalTimeout(attempt(...)`；`retry` 实参为 `true`。

---

## 步骤 6 — 确认 `ready` 过滤与导出不变
- **位置**：`loader.ts:225-227` 与 `loadExternal` 签名（`loader.ts:200`）。
- **改动**：**无代码改动**，仅核对。
- **预期产物**：超时结果（`value:undefined`）被现有过滤自然丢弃，无需额外逻辑；`loadExternal` 签名/导出未变。
- **静态核对**：`Read loader.ts:225-227` 确认仍是"仅保留 `value !== undefined`"；`Grep "export async function loadExternal"` 签名与基线一致。

---

## 步骤 7 — 全量静态核对（替代 build/run）
按顺序执行（详见 `plan.md §7`）：
1. import 块无新增（`loader.ts:1-13`）。
2. `EXTERNAL_PLUGIN_LOAD_TIMEOUT_MS` 定义唯一且两处调用均使用。
3. `Report.timeout` 为可选字段，既有字段未改。
4. 两处 `list.push`/`out[i]=` 均已包裹。
5. `withExternalTimeout` 返回类型与 `attempt` 一致；真实错误 `throw`。
6. `loadExternal` 导出/签名不变。
7. 通读全文件，确认仅新增常量+函数+可选字段，两处包裹，其余逐行等同基线。
- **预期产物**：一份"静态核对通过"清单，附行号证据。
- **静态核对**：逐条 grep + `Read` 比对基线；做"单插件超时不影响其他"走查（见 `plan.md §7`）。

---

## 可选增强（非验收必需，按需）
- **阈值可配置**：将 `EXTERNAL_PLUGIN_LOAD_TIMEOUT_MS` 改为
  `Number(process.env.OPENCODE_PLUGIN_LOAD_TIMEOUT_MS) || 30000`（无新依赖，仅用内置 `process`/`Number`）。
  - 核对：确认未新增任何 `import`（Node/Bun 运行时 `process` 为全局）。
- **真实取消预留**：在 `withExternalTimeout` 内构造 `AbortController` 并预留传给下游（当 `resolvePluginTarget`/`import` 未来支持 signal 时启用），当前仅作为注释占位，不改变隔离语义。

---

## 回退
- 删除步骤 1–3 新增内容，把步骤 4、5 的两处调用还原为直接 `attempt(...)`，即回到基线（单文件、可 git/sandbox 副本比对还原）。
