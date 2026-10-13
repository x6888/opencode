# T1 验证报告（验证者 / 流程 4.4）

> 验证对象：改码子Agent 在 `packages/opencode/src/session/overflow.ts` 的改动
> 对照文档：`optimization/T1/plan.md`、`steps.md`、`implementation.md`
> 验证方式：静态/结构核对（读代码 + 逻辑走查），本环境无构建/运行能力
> 验证者未修改任何代码。

---

## 验收标准逐条核对

### 标准 1：动态预留 + 最小缓冲，替换固定 20_000，保留 `cfg.compaction.reserved` 覆盖（向后兼容）
**✅ PASS**

- 证据 `overflow.ts:10-13`：固定 `COMPACTION_BUFFER = 20_000` 已删除，替换为
  - `const RESERVE_RATIO = 0.25`
  - `const MIN_RESERVE_BUFFER = 20_000`（原固定值降级为"地板"）
  - `const COMPACTION_THRESHOLD = 0.9`（属于标准2，此处一并说明）
- 证据 `overflow.ts:20-25`：`reserved` 计算为
  ```ts
  const reserved =
    input.cfg.compaction?.reserved ??
    Math.max(
      MIN_RESERVE_BUFFER,
      Math.floor(RESERVE_RATIO * ProviderTransform.maxOutputTokens(input.model, input.outputTokenMax)),
    )
  ```
  - `cfg.compaction?.reserved ??` 覆盖路径**原样保留** → 向后兼容 ✅
  - 预留 = `max(最小缓冲, 比例 × 模型最大输出 token)` → 动态化 ✅
  - `Math.max(MIN_RESERVE_BUFFER, …)` 保证下限不低于原 20_000 ✅
- 全仓 grep 确认 `COMPACTION_BUFFER` 已无任何源码引用（仅存于文档），`RESERVE_RATIO`/`MIN_RESERVE_BUFFER` 仅出现在 `overflow.ts` 中 → 无残留、无外溢。

### 标准 2：新增预压缩阈值（默认 0.9），`isOverflow()` 在接近硬限前（count ≥ usable×阈值）触发
**✅ PASS**

- 证据 `overflow.ts:13`：`const COMPACTION_THRESHOLD = 0.9`。
- 证据 `overflow.ts:42-44`：
  ```ts
  // 预压缩：达到可用上限的 COMPACTION_THRESHOLD 比例即触发，提前于硬限压缩
  const limit = usable(input)
  return count >= Math.floor(limit * COMPACTION_THRESHOLD)
  ```
  - 触发条件 `count >= floor(usable() × 0.9)`，即在达到硬限（100%）前于 90% 即触发 → 预压缩 ✅
  - `Math.floor` 避免浮点比较歧义，与 `plan.md` §3.3 一致。
- 早退逻辑保留：证据 `overflow.ts:37`（`auto === false → false`）、`overflow.ts:38`（`context === 0 → false`），调用方语义不受影响。

### 标准 3：改动仅限 `overflow.ts` 单文件、无新依赖、TS 风格一致
**✅ PASS**（结构核对）

- 单文件范围：全仓 grep 上述 3 个新常量，仅命中 `overflow.ts` 与 3 份规划文档（`plan.md`/`steps.md`/`implementation.md`），**任何 `.ts` 源码均未引用** → 改动未扩散。
- import 块未变：证据 `overflow.ts:1-6`，import 仍为 `Config` / `ConfigV1` / `SessionV1` / `Provider` / `ProviderTransform` / `MessageV2`，**无新增 import、无新第三方依赖**。
- TS 风格一致：常量沿用 `COMPACTION_*` UPPER_SNAKE 命名（与既有 `COMPACTION_BUFFER` 风格统一）；未引入任何类型或运行时新符号；`Math.max`/`Math.floor`/`??` 均为项目既有写法。
- 说明：本目录非 git 仓库，无法用 `git diff` 机械确认；上述以"全仓符号引用 + import 块"做结构核对，结论为单文件无外溢。

### 标准 4：附 before/after 行为说明与最小核对
**✅ PASS**

- 证据 `implementation.md` 第 3 节（L60-77）：含 Before/After 走查，场景 A–E 覆盖
  - A：小输出模型（maxOutput=8k）预留由 8k→20k（地板生效）
  - B：大输出模型（maxOutput=128k）预留 20k→32k（比例生效）
  - C：`cfg.compaction.reserved=50_000` 覆盖一致（向后兼容）
  - D：`auto === false` 早退一致
  - E：`context === 0` / `usable=0` 边界无新异常
- 证据 `implementation.md` 第 5 节（L93-97）及 `steps.md` 步骤①–③ 均给出静态核对方式（grep 确认无 `COMPACTION_BUFFER`、确认 `??` 覆盖路径、用场景走查核对）。最小核对项齐备。

### 标准 5：不破坏现有导出（`usable`/`isOverflow`）与调用方语义（返回值始终非负、单调合理）
**✅ PASS**

- 导出签名未变：证据 `overflow.ts:15` `export function usable(...)`、`:31` `export function isOverflow(...)` 签名与入参结构均与改前一致（仅内部实现变化）。
- 返回值恒非负：证据 `overflow.ts:26-28`
  ```ts
  return input.model.limit.input
    ? Math.max(0, input.model.limit.input - reserved)
    : Math.max(0, context - ProviderTransform.maxOutputTokens(input.model, input.outputTokenMax))
  ```
  两分支均 `Math.max(0, …)`，返回值恒为非负整数 ✅
- 单调合理：`usable` 随 `reserved` 增大而减小，而 `reserved` 随模型输出能力增大而增大（即"能输出越多，给输出预留越多"），符合预期，单调方向正确。`isOverflow` 提前于硬限触发，不会比改前更晚，对调用方更安全。
- 边界一致性：场景 E 中 `usable=0` 时 `isOverflow: count >= floor(0×0.9)=0`，与改前 `count >= 0` 行为一致，无回归 ✅
- 一处实现取舍已声明：`implementation.md` §5 说明改用 `Math.floor` 而非任务描述中的 `Math.round`，理由是与 `plan.md` §3.2 对齐、避免浮点比较歧义 —— 该取舍与 plan 一致，属可控、已记录偏差，不影响语义。

---

## 优化闭环判定

**闭环已达成** ✅

改码子Agent 已交付：计划（`plan.md`）→ 步骤（`steps.md`）→ 实现（`implementation.md`）三件套齐全，且 `overflow.ts` 实际改动逐条命中 5 条验收标准：
- 固定 20_000 已替换为"比例×maxOutput + 最小缓冲地板"，并保留 `cfg.compaction.reserved` 覆盖（标准1）；
- 新增 0.9 预压缩阈值，`isOverflow` 提前触发（标准2）；
- 改动收敛于 `overflow.ts` 单文件、无新依赖、TS 风格一致（标准3）；
- implementation.md 含 before/after 走查与最小核对（标准4）；
- 导出与调用方语义未破坏、返回值恒非负（标准5）。

无未满足项，无需下一轮补改。

---

## 偏差/备注（不阻断闭环）
- 环境非 git 仓库，标准3的"单文件"以全仓符号引用 + import 块结构核对佐证，而非 `git diff` 机械确认；结论可信但非 git 级铁证。
- 实现中 `Math.floor` 与任务原始描述里的 `Math.round` 不同，但已与 `plan.md` 对齐并记录于 `implementation.md` §5，属计划内取舍，不视为缺陷。
