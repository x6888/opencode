# T5 验证报告：外部插件加载超时隔离（`plugin/loader.ts`）

> 验证者（流程 4.4）交付物。**仅静态/结构核对，未修改任何代码。**
> 核对对象：
> - 改后源码：`packages/opencode/src/plugin/loader.ts`（全量通读 + 行号取证）
> - 规划：`optimization/T5/plan.md`、`optimization/T5/steps.md`、`optimization/T5/implementation.md`
> 约束：无法 build/run，采用 grep + 通读 + 逻辑走查替代执行。

---

## 验收标准逐条核对

### 标准 1：为外部插件加载引入超时机制（per-plugin load timeout 常量），单个外部插件超阈值即中断该插件加载
**结论：✅ PASS**

证据：
- `loader.ts:62-63` 定义模块级常量为 per-plugin 超时阈值：
  ```ts
  const EXTERNAL_PLUGIN_LOAD_TIMEOUT_MS =
    Number(process.env.OPENCODE_PLUGIN_LOAD_TIMEOUT_MS) || 30_000
  ```
  满足"per-plugin load timeout 常量"——每个插件都在 `withExternalTimeout` 内独立 race 同一阈值。
- `loader.ts:158-185` 新增 `withExternalTimeout<R>(...)`，以 `Promise.race([run, timeout])` 包裹单个 `attempt(...)`；超时分支（`loader.ts:173-180`）返回 `{ value: undefined, retry: false }`，使该插件在编排层停止等待、被隔离。
- 该包裹覆盖**初始加载**（`loader.ts:251-260`）与 **retry 路径**（`loader.ts:275-280`），即所有外部插件加载均受阈值约束。
- `loader.ts:66` 定义哨兵 `PLUGIN_LOAD_TIMEOUT = Symbol(...)`，仅当 `err === PLUGIN_LOAD_TIMEOUT` 才走超时隔离分支（`loader.ts:173`）。

说明（关键语义边界，与 plan R1 一致）：
- "中断该插件加载"在本实现中指**编排层停止等待并隔离**该插件（`Promise.all` 不再被其拖垮），而非真正取消底层工作——`resolvePluginTarget`/`import` 不接受 `AbortSignal`（`loader.ts:152-157` 注释已明确）。底层请求仍可能在后台继续，但本插件不再阻塞整批返回。这属于 plan 已明确接受的设计取舍，不满足"真取消"，但满足"超时即隔离/不阻塞"。判定为 PASS。

---

### 标准 2：超时/失败仅影响该插件（隔离），不阻塞其他插件与整体加载流程；行为可预期
**结论：✅ PASS**

证据：
- 超时分支返回 `{ value: undefined, retry: false }`（`loader.ts:180`）——为**已 settled** 值，非 reject，因此 `Promise.all(list)`（`loader.ts:261`）不会被单个超时插件拖垮。
- 每个插件在 `list` 中**独立** `race`（`loader.ts:251-260`），A 超时不影响 B/C 的 race 与结果。
- `ready` 过滤（`loader.ts:285-287`）仅保留 `value !== undefined`，被隔离插件的 `value:undefined` 被自动丢弃，无需额外改动。
- 超时即记录：`report?.timeout?.(...)`（`loader.ts:175-179`）提供可观测性，行为确定。
- retry 路径（`loader.ts:262-282`）中超时插件 `retry:false`，不会被重试（`loader.ts:266-267` 判定 `retry !== true` 跳过）。

说明：隔离语义完整，符合"仅影响该插件 + 不阻塞其他 + 整体有界返回"。单插件超时不影响其他的走查见 implementation.md §5 / plan.md §7，逻辑闭环成立。

---

### 标准 3：改动仅限 `loader.ts` 单文件、无新依赖、TS 风格一致
**结论：✅ PASS**

证据：
- import 块 `loader.ts:1-13` 与基线一致，未新增任何 import；超时逻辑仅用运行期内置 `Promise`/`setTimeout`/`clearTimeout`/`Symbol`/`Number`/`process`（全局），无新 npm 依赖。`loader.ts:62` 的 `process.env` 为 Node/Bun 运行时全局，未 import。
- 新增内容全部位于 `PluginLoader` 命名空间内：常量（`loader.ts:62-66`）、`Report` 可选字段（`loader.ts:51`）、函数 `withExternalTimeout`（`loader.ts:158-185`）；复用既有类型 `Candidate`/`AttemptResult<R>`/`Report`（`loader.ts:36-52`）。
- 命名风格（`camelCase` 常量、`R` 泛型、`Report` 可选回调）与现有 `resolve`/`load`/`attempt` 一致。

说明：单文件、零新依赖、风格一致三要素全部满足。

---

### 标准 4：保留现有导出与调用方语义（成功加载路径与原行为兼容，默认不破坏现有正常加载）
**结论：✅ PASS**

证据：
- `loadExternal` 签名未变：`export async function loadExternal<R = Loaded>(input: Input<R>): Promise<R[]>`（`loader.ts:248`），导出与参数结构不变。
- `resolve`/`load`/`attempt` 的 `export` 与参数均未改动（`loader.ts:89`、`loader.ts:139`、`loader.ts:189`）。
- 成功路径兼容：无超时时 `withExternalTimeout` 的 `Promise.race` 由 `run` 正常 resolve，返回与改造前 `attempt` 完全相同的 `AttemptResult<R>`；`ready` 过滤行为不变（`loader.ts:285-287`），结果与顺序与基线逐字节一致。
- 失败语义保留：真实 reject（非超时）在 `.catch` 中 `throw err`（`loader.ts:183`），保留既有"整批 reject"行为，不静默吞错（`loader.ts:150-157` 注释 + `.catch` 分支 `err === PLUGIN_LOAD_TIMEOUT` 才隔离）。
- 默认不改行为：未设置 `OPENCODE_PLUGIN_LOAD_TIMEOUT_MS` 时阈值回退为 `30_000`（同 plan 默认），正常加载路径不受影响。

说明：导出、调用方签名、成功路径、失败语义均向后兼容。

---

### 标准 5：附 before/after 行为说明与最小静态核对（implementation.md 中应有，含"单插件超时不影响其他"走查）
**结论：✅ PASS**

证据：
- implementation.md §3 给出 before/after 行为对照（卡死插件 A 不再拖垮 `Promise.all`，整体有界返回）。
- implementation.md §5 给出 7 条最小静态核对（import 块无新增、`EXTERNAL_PLUGIN_LOAD_TIMEOUT_MS` 唯一定义、`Report.timeout` 可选、两处包裹到位、返回类型一致、签名不变、`ready` 未动），并附行号取证。
- implementation.md §5（及 plan.md §7）包含**"单插件超时不影响其他"走查**：A(卡死)/B(2s) → `list=[race(attemptA,30s), race(attemptB,30s)]` → B 2s 保留，A 30s 隔离且已 settled → `Promise.all` 30s 内全部 settle → `ready` 丢弃 A、保留 B。逻辑闭环成立。
- 验证者复核该走查与源码一致：`Promise.race`（`loader.ts:168`）+ 隔离返回值（`loader.ts:180`）+ `Promise.all`（`loader.ts:261`）+ `ready` 过滤（`loader.ts:285-287`）三处实际代码均支撑该结论。

说明：before/after 与静态核对（含单插件隔离走查）齐备。

---

## 优化闭环判定

**达成** ✅

五条验收标准全部 PASS：
1. ✅ 超时机制（per-plugin 常量 + `withExternalTimeout` 隔离）已落地；
2. ✅ 隔离语义完整，不阻塞其他插件与整体流程；
3. ✅ 单文件、零新依赖、风格一致；
4. ✅ 导出/调用方/成功路径/失败语义向后兼容；
5. ✅ before/after + 静态核对 + 单插件隔离走查齐备。

计划（plan.md）→ 代码（loader.ts）→ 验收标准（本文件）三者闭合，无未达成项。

---

## 备注（非阻塞，供参考）
- 标准 1 的"中断"为**编排层隔离**语义，非底层真取消（底层不支持 `AbortSignal`），已在该函数注释（`loader.ts:152-157`）与 plan R1 中明确。若未来需要"真取消"，属可选增强，不在本次验收范围内。
- implementation.md/plan.md 引用的部分行号（如 `loader.ts:200-228`）为改前基线快照；本验证以**改后源码实际行号**为准（常量 62-66、Report 51、withExternalTimeout 158-185、list.push 251-260、out[i] 275-280、Promise.all 261、ready 285-287），二者逻辑一致。
