# T1 实现说明（改码者 / 流程 4.3）

> 文件：`packages/opencode/src/session/overflow.ts`（单文件改动，无新依赖、不改 import/导出）
> 对应计划：`optimization/T1/plan.md` + `optimization/T1/steps.md`
> 环境：无构建/运行能力，仅静态改码，已用 Read 复查语法/括号。

---

## 1. 改了什么（一句话）

把固定 20_000 缓冲改为"按模型最大输出 token 比例动态预留 + 最小缓冲地板"，并在 `isOverflow()` 引入 0.9 预压缩阈值，使压缩提前于硬限触发、且对大输出模型自动留更大余量。

---

## 2. 关键 diff 摘要

### 2.1 常量替换（L8 → L8-13）

```diff
-const COMPACTION_BUFFER = 20_000
+// 动态预留：预留空间 = max(最小缓冲, 比例 × 模型最大输出 token)
+// 大输出模型自动获得更大余量；小模型以 MIN_RESERVE_BUFFER 为安全下限
+const RESERVE_RATIO = 0.25
+const MIN_RESERVE_BUFFER = 20_000
+// 预压缩阈值：达到可用上限的该比例即触发压缩（提前于硬限，避免真正撞窗）
+const COMPACTION_THRESHOLD = 0.9
```

### 2.2 `usable()` 的 reserved 计算（L14-16 → L19-25）

```diff
-  const reserved =
-    input.cfg.compaction?.reserved ??
-    Math.min(COMPACTION_BUFFER, ProviderTransform.maxOutputTokens(input.model, input.outputTokenMax))
+  // 预留空间：优先取 cfg 显式覆盖（向后兼容），否则按模型输出能力动态计算
+  const reserved =
+    input.cfg.compaction?.reserved ??
+    Math.max(
+      MIN_RESERVE_BUFFER,
+      Math.floor(RESERVE_RATIO * ProviderTransform.maxOutputTokens(input.model, input.outputTokenMax)),
+    )
```

### 2.3 `isOverflow()` 判定（L33 → L42-44）

```diff
-  return count >= usable(input)
+  // 预压缩：达到可用上限的 COMPACTION_THRESHOLD 比例即触发，提前于硬限压缩
+  const limit = usable(input)
+  return count >= Math.floor(limit * COMPACTION_THRESHOLD)
```

### 2.4 注释（不增逻辑）

- 常量处说明"动态预留"与"预压缩阈值"意图及可调点。
- `usable()` / `isOverflow()` 改动处各补 1 行意图注释。

---

## 3. Before / After 行为走查（伪测试，无需运行）

**场景 A**：context=200_000，input=200_000，maxOutput=8_000
- Before：`reserved=min(20_000,8_000)=8_000`；`usable=192_000`；`isOverflow: count>=192_000`
- After：`reserved=max(20_000, floor(0.25×8_000)=2_000)=20_000`；`usable=180_000`；`isOverflow: count>=floor(180_000×0.9)=162_000`（更早预压缩；可用略减，符合风险1）

**场景 B**：context=1_000_000，input=1_000_000，maxOutput=128_000
- Before：`reserved=min(20_000,128_000)=20_000`；`usable=980_000`；`isOverflow: count>=980_000`
- After：`reserved=max(20_000, floor(0.25×128_000)=32_000)=32_000`；`usable=968_000`；`isOverflow: count>=floor(968_000×0.9)=871_200`（大模型余量更大、更早压缩，更稳）

**场景 C**：`cfg.compaction.reserved = 50_000`（显式覆盖）
- Before/After：`reserved` 均直接取 50_000 → 向后兼容 ✅

**场景 D**：`cfg.compaction.auto === false`
- Before/After：`isOverflow` 均在 L28 早退返回 `false` → 语义不变 ✅

**场景 E**：`context === 0` 或 `usable()` 返回 0
- Before/After：`isOverflow` 早退 / `count >= floor(0×0.9)=0`，与改前 `count>=0` 行为一致，无新异常 ✅

---

## 4. 验收对照（对齐主Agent 5 条标准）

| # | 验收标准 | 落点 |
|---|---|---|
| 1 | 动态预留 + 最小缓冲；保留 `cfg.compaction.reserved` 覆盖，向后兼容 | ✅ 见 2.2：`RESERVE_RATIO×maxOutput` + `MIN_RESERVE_BUFFER` 地板；`cfg.compaction?.reserved ??` 不变 |
| 2 | 预压缩阈值（默认 0.9），`count ≥ usable×阈值` 触发 | ✅ 见 2.3：`COMPACTION_THRESHOLD = 0.9`，`count >= floor(usable×0.9)` |
| 3 | 仅 `overflow.ts` 单文件、无新依赖、TS 风格一致 | ✅ 仅 3 处改动 + 3 常量；import/导出未动；命名沿用 `COMPACTION_*` 风格 |
| 4 | Before/after 行为说明 | ✅ 见第 3 节 |
| 5 | 不破坏导出与调用方语义（返回值恒非负、单调合理） | ✅ 函数签名/导出不变；`usable` 仍 `Math.max(0,…)` 非负；`isOverflow` 早退逻辑保留 |

---

## 5. 冲突检查 & 偏离说明

- **plan 与当前文件无冲突**，所有行号/引用对齐。
- **一处实现取舍说明**：任务描述中 `reserved` 写做 `Math.round(...)`，而 `plan.md` §3.2 明确使用 `Math.floor(...)`。按约束"如 plan 另有命名/数值，以 plan.md 为准"，此处采用 `Math.floor`（与 plan/steps 一致，避免浮点比较歧义）。
- 未引入任何新依赖、未修改 `usable`/`isOverflow` 签名、未改动 `config` schema 与 import。

---

## 6. 回退方式（如需）

恢复 `overflow.ts` 至原始：
- 加回 `const COMPACTION_BUFFER = 20_000`，删除 3 个新常量；
- `reserved` 恢复为 `Math.min(COMPACTION_BUFFER, ProviderTransform.maxOutputTokens(...))`；
- `isOverflow` 末行恢复为 `return count >= usable(input)`。
即可完全回到原始实现，不影响任何调用方。
