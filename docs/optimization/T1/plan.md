# T1 优化计划：overflow.ts 上下文窗口"动态预留 + 阈值预压缩"

> 子Agent角色：规划者（流程 4.2）。本文档**只规划、不改码**。所有改动收敛于单文件 `packages/opencode/src/session/overflow.ts`。
> 本环境无构建/运行能力，验证仅限静态/结构核对。

---

## 1. 优化目标

把当前"固定 20_000 缓冲 + 被动溢出（count 达到硬限才压缩）"的上下文管理，升级为：

1. **动态预留**：预留空间 = `max(最小缓冲, 比例 × 模型最大输出 token)`，使大输出模型自动获得更大余量，小模型保持安全下限；保留 `cfg.compaction.reserved` 显式覆盖（向后兼容）。
2. **阈值预压缩**：引入预压缩阈值（默认 0.9），`isOverflow()` 在 `count >= usable() × 0.9` 时即触发，提前于硬限压缩，避免真正撞窗导致截断/失败。

---

## 2. 当前实现分析（基于最新源码）

文件：`packages/opencode/src/session/overflow.ts`（35 行）

- **L8** 模块常量：`COMPACTION_BUFFER = 20_000`（固定值）。
- **L10-20** `usable(input)`：
  - `context = model.limit.context`；`context === 0` 直接返回 0。
  - `reserved = cfg.compaction?.reserved ?? Math.min(COMPACTION_BUFFER, maxOutputTokens(model, outputTokenMax))` —— **固定 20_000 作为上限/下限**。
  - 返回：
    - 若 `model.limit.input` 存在：`Math.max(0, input - reserved)`
    - 否则：`Math.max(0, context - maxOutputTokens(...))`（**此分支根本没用 `reserved`**）。
- **L22-34** `isOverflow(input)`：
  - `auto === false` → `false`；`context === 0` → `false`。
  - `count = tokens.total || input+output+cache.read+cache.write`。
  - **L33** `return count >= usable(input)` —— 被动：只有 count 达到硬上限才触发。

**问题定位**：
1. `reserved` 写死 20_000，对能输出 100k+ 的模型留的余量偏小，对只能输出 4k 的模型又偏保守；不随模型能力缩放。
2. 触发点 = 硬上限，属于"溢出后才压缩"的被动策略，临近窗口时风险高。
3. `usable()` 的 else 分支未消费 `reserved`，逻辑不对称（后续改动应保持该分支现状，避免扩大影响面）。

---

## 3. 优化方案（具体代码改动要点 / 伪码）

### 3.1 新增模块级常量（替换 L8 的 `COMPACTION_BUFFER`）

```ts
// 动态预留：预留空间 = max(最小缓冲, 比例 × 模型最大输出 token)
const RESERVE_RATIO = 0.25            // 按模型最大输出能力的比例预留
const MIN_RESERVE_BUFFER = 20_000     // 最小缓冲下限（原固定值降级为"地板"，保证小模型安全）
// 预压缩阈值：达到可用上限的该比例即触发压缩（提前于硬限）
const COMPACTION_THRESHOLD = 0.9
```

> 命名与现有 `COMPACTION_BUFFER` 风格一致（UPPER_SNAKE）。不引入任何新依赖、不新增 config 字段。
> 阈值 / 比例均以常量暴露，便于后续（由别的 PR）提升为 `cfg.compaction` 配置项，本任务不触碰 config schema。

### 3.2 改 `usable()` 的 reserved 计算（仅改 L14-16）

```ts
const reserved =
  input.cfg.compaction?.reserved ??
  Math.max(
    MIN_RESERVE_BUFFER,
    Math.floor(RESERVE_RATIO * ProviderTransform.maxOutputTokens(input.model, input.outputTokenMax)),
  )
```

- **向后兼容**：`cfg.compaction?.reserved` 仍优先（与现状完全一致），显式覆盖路径不变。
- **动态化**：reserved 随模型输出能力缩放；`Math.max(地板, …)` 保证最坏情况不低于原 20_000。
- `usable()` 其余逻辑（输入上限分支 / 上下文分支 / `Math.max(0, …)` 非负保护）**原样保留**，确保 `usable()` 返回值始终非负、单调合理。

### 3.3 改 `isOverflow()` 的判定（仅改 L33）

```ts
const limit = usable(input)
return count >= Math.floor(limit * COMPACTION_THRESHOLD)
```

- 提前 10% 触发（默认），实现"预压缩"。
- `auto === false` 与 `context === 0` 的早退逻辑保留不变，调用方语义不受影响。
- `Math.floor` 避免浮点比较歧义；当 `limit` 为整数时结果与预期一致。

### 3.4 配套注释（新增，不增逻辑）

在常量处与两个函数改动处各补 1-2 行中文注释，说明"动态预留"与"预压缩阈值"的意图，便于下一个子Agent（改码者）理解与回退。

---

## 4. 预期收益

| 维度 | 改前 | 改后 |
|---|---|---|
| 预留策略 | 固定 20_000 | 随模型输出能力缩放，下限 20_000 |
| 大输出模型（如 maxOutput=128k） | 仅留 20k，撞窗风险高 | 自动留 ~32k，余量充足 |
| 触发时机 | 达到硬限才压缩（被动） | 达 90% 即压缩（预压缩） |
| 向后兼容 | — | `cfg.compaction.reserved` 覆盖仍生效 |
| 依赖 / 文件范围 | — | 仅 `overflow.ts` 单文件，0 新依赖 |

---

## 5. 风险与回退策略

**风险 1（小输出模型预留变大）**：原 `min(20_000, maxOutput)` 对 maxOutput<20k 的模型只留 maxOutput（如 8k）；新方案 `max(20_000, …)` 会留满 20_000，可用空间略减。
- 影响：可用 token 变小，但不会出错，且更安全（更大余量）。
- 缓解：若担心，可调小 `MIN_RESERVE_BUFFER`（如 4_000）；或把地板改为 `Math.min(MIN_RESERVE_BUFFER, maxOutput)`。本计划在步骤中标注该可调点。

**风险 2（预压缩过早触发导致频繁压缩）**：阈值 0.9 偏高可能让本就接近上限的会话更频繁触发 compaction。
- 缓解：阈值以常量暴露，可下调（如 0.85）；且 `auto === false` 可完全关闭。

**回退策略**：改动完全自包含于 `overflow.ts`；回退只需把 L14-16 恢复为 `Math.min(COMPACTION_BUFFER, maxOutputTokens(...))`、L33 恢复为 `count >= usable(input)`，并删去新增的 3 个常量即可，不影响任何调用方。

---

## 6. 验收对照表（逐条对照主Agent 5 条标准）

| # | 验收标准 | 本方案是否满足 / 落点 |
|---|---|---|
| 1 | 用"按 maxOutput 比例动态预留 + 最小缓冲"替换固定 20_000，保留 `cfg.compaction.reserved` 覆盖，向后兼容 | ✅ 见 3.1 / 3.2：`RESERVE_RATIO × maxOutput` + `MIN_RESERVE_BUFFER` 地板；`cfg.compaction?.reserved ??` 不变 |
| 2 | 新增预压缩阈值（默认 0.9），`isOverflow` 在接近硬限前（count ≥ usable×阈值）触发 | ✅ 见 3.1 / 3.3：`COMPACTION_THRESHOLD = 0.9`，判定改为 `count >= floor(usable×0.9)` |
| 3 | 仅限 `overflow.ts` 单文件、无新依赖、TS 风格与 import/命名一致 | ✅ 仅改 3 处 + 新增 3 常量；import 不变；命名沿用 `COMPACTION_*` 风格 |
| 4 | 附 before/after 行为说明与最小核对方式（逻辑走查 / 伪测试） | ✅ 见本文 2 节分析 + 第 7 节 before/after + `steps.md` 静态核对项 |
| 5 | 不破坏导出（`usable`/`isOverflow`）与调用方语义（返回值始终非负、单调合理） | ✅ 函数签名/导出不变；`usable` 仍 `Math.max(0,…)` 非负；`isOverflow` 早退逻辑保留 |

---

## 7. Before / After 行为走查（伪测试，无需运行）

**场景 A**：context=200_000，input=200_000，maxOutput=8_000
- 改前：`reserved=min(20_000,8_000)=8_000`；`usable=200_000-8_000=192_000`；`isOverflow: count>=192_000`
- 改后：`reserved=max(20_000, floor(0.25×8_000)=2_000)=20_000`；`usable=180_000`；`isOverflow: count>=floor(180_000×0.9)=162_000`（更早预压缩；可用略减，符合风险1）

**场景 B**：context=1_000_000，input=1_000_000，maxOutput=128_000
- 改前：`reserved=min(20_000,128_000)=20_000`；`usable=999_980_000`→ 实际 `1_000_000-20_000=980_000`；`isOverflow: count>=980_000`
- 改后：`reserved=max(20_000, floor(0.25×128_000)=32_000)=32_000`；`usable=968_000`；`isOverflow: count>=floor(968_000×0.9)=871_200`（大模型余量更大、更早压缩，更稳）

**场景 C**：`cfg.compaction.reserved = 50_000`（显式覆盖）
- 改前/改后：`reserved` 均直接取 50_000（覆盖路径完全一致）→ 向后兼容 ✅

**场景 D**：`cfg.compaction.auto === false`
- 改前/改后：`isOverflow` 均在 L28 早退返回 `false` → 语义不变 ✅

**场景 E**：`context === 0` 或 `usable()` 返回 0
- `isOverflow` 早退 / `count >= floor(0×0.9)=0` → 与改前 `count>=0` 行为一致，无新异常 ✅
