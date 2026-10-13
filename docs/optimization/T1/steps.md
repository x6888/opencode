# T1 执行步骤清单（overflow.ts 动态预留 + 阈值预压缩）

> 供下一个子Agent（改码者）逐步执行。每步标注**预期产物**与**如何静态核对**（本环境无法运行，仅结构/逻辑核对）。
> 全程只动 `packages/opencode/src/session/overflow.ts` 单文件，不新增依赖、不改 config schema、不改 import 与导出签名。

---

## 步骤 ①：新增模块级常量（替换 L8 `COMPACTION_BUFFER`）

- **操作**：删除 `const COMPACTION_BUFFER = 20_000`，在 L8 位置新增：
  ```ts
  // 动态预留：预留空间 = max(最小缓冲, 比例 × 模型最大输出 token)
  const RESERVE_RATIO = 0.25
  const MIN_RESERVE_BUFFER = 20_000
  // 预压缩阈值：达到可用上限的该比例即触发压缩（提前于硬限）
  const COMPACTION_THRESHOLD = 0.9
  ```
- **预期产物**：文件顶部出现 3 个 UPPER_SNAKE 常量；不再有 `COMPACTION_BUFFER`。
- **静态核对**：
  - Grep 确认 `COMPACTION_BUFFER` 已无引用。
  - 确认 `RESERVE_RATIO`/`MIN_RESERVE_BUFFER`/`COMPACTION_THRESHOLD` 均为 number 字面量，无外部引用。

## 步骤 ②：改 `usable()` 的 reserved 计算（L14-16）

- **操作**：把
  ```ts
  const reserved =
    input.cfg.compaction?.reserved ??
    Math.min(COMPACTION_BUFFER, ProviderTransform.maxOutputTokens(input.model, input.outputTokenMax))
  ```
  改为
  ```ts
  const reserved =
    input.cfg.compaction?.reserved ??
    Math.max(
      MIN_RESERVE_BUFFER,
      Math.floor(RESERVE_RATIO * ProviderTransform.maxOutputTokens(input.model, input.outputTokenMax)),
    )
  ```
- **预期产物**：reserved 变为 `cfg.compaction?.reserved ?? max(地板, 比例×maxOutput)`；函数其余行（L11-13、L17-19）原样保留。
- **静态核对**：
  - `cfg.compaction?.reserved` 的 `??` 覆盖路径仍存在（向后兼容）。
  - `usable()` 最终仍走 `Math.max(0, …)` → 返回值恒非负（对照验收标准 5）。
  - else 分支（无 `model.limit.input` 时）逻辑未变，仍用 `maxOutputTokens` 而非 `reserved`（保持现状，不扩大影响面）。

## 步骤 ③：改 `isOverflow()` 的判定（L33）

- **操作**：把 `return count >= usable(input)` 改为
  ```ts
  const limit = usable(input)
  return count >= Math.floor(limit * COMPACTION_THRESHOLD)
  ```
- **预期产物**：`isOverflow` 在 `count` 达到可用上限的 90% 即触发（预压缩）。
- **静态核对**：
  - 上方 L28（`auto === false` 早退）、L29（`context === 0` 早退）保持不变。
  - `count` 计算（L31-32）不变。
  - 用 plan.md 第 7 节场景 A–E 做逻辑走查：`count >= floor(usable×0.9)` 在场景 C/D/E 与改前语义一致或仅提前触发。

## 步骤 ④：补注释（不增逻辑，仅说明意图）

- **操作**：在 3 个常量处及 `usable`/`isOverflow` 改动处各加 1–2 行中文注释，说明"动态预留"与"预压缩阈值"用途及可调点（如 `MIN_RESERVE_BUFFER` 可按需下调、`COMPACTION_THRESHOLD` 可下调以降频）。
- **预期产物**：无逻辑变化，仅可读性提升，方便回退与后续配置化。
- **静态核对**：注释不引入新符号、不改动任何执行语句。

## 步骤 ⑤：写 before/after 说明并做最终静态核对

- **操作**：把 plan.md 第 7 节 Before/After 走查（场景 A–E）作为行为说明留存；逐项核对下方清单。
- **预期产物**：验收对照全部命中。
- **静态核对清单（逐条对照验收标准）**：
  1. ✅ 固定 20_000 已替换为 `RESERVE_RATIO×maxOutput + MIN_RESERVE_BUFFER` 地板；`cfg.compaction.reserved` 覆盖仍在。
  2. ✅ `COMPACTION_THRESHOLD = 0.9` 已用，`isOverflow` 改为 `count >= floor(usable×0.9)`。
  3. ✅ 仅 `overflow.ts` 改动；无新 import、无新依赖；命名沿用 `COMPACTION_*` 风格。
  4. ✅ 已附 before/after 伪测试（plan.md §7）与步骤①–③的静态核对方式。
  5. ✅ `usable`/`isOverflow` 导出签名与返回值语义不变；`usable` 非负、早退逻辑保留。

---

## 原子性 / 回退提示
- 每一步可独立 `git diff` 核对；若某步不愿采纳（如风险1的小模型预留变大），仅回退步骤②即可，不影响步骤③的预压缩。
- 全量回退：恢复 L14-16 为 `Math.min(COMPACTION_BUFFER, maxOutputTokens(...))`、L33 为 `count >= usable(input)`、恢复 `COMPACTION_BUFFER` 常量、删除新增 3 常量 → 完全回到原始实现。
