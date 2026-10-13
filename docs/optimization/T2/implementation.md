# T2 实现说明（改码者 · 流程 4.3）

> 单文件改动：`packages/opencode/src/tool/truncate.ts`
> 环境：无 build/run 能力，仅静态/结构核对。
> 对齐：`optimization/T2/plan.md`、`optimization/T2/steps.md`

---

## 1. 一句话总结

为 `truncate.ts` 新增「按工具 id 的截断策略表（`TRUNCATION_STRATEGIES`）」与 `middle` 截断分支，并把 `write()` 改为基于内容哈希的进程内去重（复用已有 `tool_NNNN` 文件名）；未传 `toolID` 时行为与原实现逐字节等价。

---

## 2. 改动清单（关键 diff 摘要）

### S1 — 新增 `node:crypto` import（标准库，非 npm 依赖）
```ts
import { createHash } from "node:crypto"
```

### S2 — 策略类型 + 策略表（模块级常量，紧接 `GLOB` 之后）
```ts
type TruncateStrategy = {
  maxLines?: number
  maxBytes?: number
  direction?: "head" | "tail" | "middle"
}
const DEFAULT_TRUNCATION_STRATEGY: TruncateStrategy = { direction: "head" }
const TRUNCATION_STRATEGIES: Record<string, TruncateStrategy> = {
  bash:  { direction: "tail" },
  shell: { direction: "tail" },
  grep:  { direction: "head", maxLines: 1000 },
  read:  { direction: "middle" },
}
```

### S3 — `Options` 扩展（向后兼容，纯新增可选字段）
```ts
export interface Options {
  maxLines?: number
  maxBytes?: number
  direction?: "head" | "tail" | "middle"   // 由原计划 "head"|"tail" 放宽到含 "middle"
  toolID?: string                          // 新增：选策略表用
}
```

### S4 — 策略解析（替换原 L86-89 无差别取值）
```ts
const strategy = (options.toolID && TRUNCATION_STRATEGIES[options.toolID]) || DEFAULT_TRUNCATION_STRATEGY
const maxLines  = options.maxLines  ?? strategy.maxLines  ?? resolved.maxLines
const maxBytes  = options.maxBytes  ?? strategy.maxBytes  ?? resolved.maxBytes
const direction = options.direction ?? strategy.direction ?? "head"
```
优先级：`options.*` 显式 > 策略表 > `limits()` 默认。不传 `toolID` → `direction="head"`、`maxLines/maxBytes=limits()`，与改动前等价。

### S5 — 新增 `middle` 分支（`if / else if / else` 三段）
- 头预算/尾预算各半（行、字节双限各半），`headLines`/`tailLines` 分别按 `maxLines/maxBytes` 双限收集合法行。
- 头尾重叠（`headLines.length + tailLines.length >= lines.length`）时退化为 `lines.slice(0, maxLines)` 并清空两端数组，**不产生重复行、不越 `maxLines`**。
- `removed`/`unit` 在分支之后统一计算；middle 字节命中时按 `keptBytes`（头+尾实际字节）计，否则按 `out.length` 计。
- 最终 content 形态：`head…\n\n...N unit truncated...\n\n…tail\n\n${hint}`，与 head/tail 的省略标记风格一致。

### S6 — `write()` 内容去重（闭包 `Map` 缓存）
```ts
const dedup = new Map<string, string>()   // 置于 layer 的 Effect.gen 内
const write = Effect.fn("Truncate.write")(function* (text: string) {
  const h = createHash("sha256").update(text).digest("hex")
  const cached = dedup.get(h)
  if (cached) {
    const exists = yield* fs.stat(cached).pipe(Effect.map(() => true), Effect.catch(() => Effect.succeed(false)))
    if (exists) return cached          // 相同内容：复用已有文件，跳过重复落盘
  }
  const file = path.join(TRUNCATION_DIR, ToolID.ascending())  // 文件名契约不变
  yield* fs.ensureDir(TRUNCATION_DIR).pipe(Effect.orDie)
  yield* fs.writeFileString(file, text).pipe(Effect.orDie)
  dedup.set(h, file)
  return file
})
```
文件名仍为 `ToolID.ascending()`，`tool_` 前缀契约不变 → `cleanup()` 的 `startsWith("tool_")` 过滤不受影响。

---

## 3. Before / After 行为对照

| 场景 | Before | After |
|---|---|---|
| 不传 `toolID`（如 `tool.ts` 当前调用 `{}`） | head 截断、`limits()` 上限、每次 `output` 写新 `tool_NNNN` | **等价**：head 截断 + `limits()` 上限；**新增**：会话内相同 `text` 复用已落盘文件（去重），`outputPath` 指向同一文件 |
| `toolID:"grep"` | — | head 截断 + `maxLines=1000` |
| `toolID:"bash"/"shell"` | — | tail 截断（保留末尾 stderr/错误） |
| `toolID:"read"` | — | middle 截断（头半 + 尾半 + 中间省略） |
| 返回形态 | `{content,truncated:false}` 或 `{content,truncated:true,outputPath}` | 不变 |

---

## 4. 验收对照（对齐主Agent 5 条）

1. ✅ 策略表 + `Options.toolID` + 策略解析 + `middle` 分支 — 机制具备，默认路径等价于原 head（opt-in，见 R1）。
2. ✅ `write()` 闭包哈希缓存，会话内相同内容复用 `tool_NNNN`，不重复落盘。
3. ✅ 仅 `truncate.ts` 单文件；`node:crypto` 为标准库；命名 `UPPER_CASE` 与既有风格一致。
4. ✅ `Options` 仅加可选字段；未传 `toolID` 时 `direction/maxLines/maxBytes` 与现版一致；`Result`/`Interface`/`Service` 不变。
5. ✅ 见本文件 §2/§3 before/after。

---

## 5. 与 plan 的差异 / 冲突说明（按最安全方式实现并标注）

- **差异 A（`middle` 内 `removed` 的计算位置）**：plan §3.4 伪码在 `out.concat` 内直接内嵌 `...${removed} ${unit} truncated...`，但 `removed/unit` 在其后（原 L124-125）才定义，TS 下属 TDZ 错误。改码者改为：**先在各分支构建 `out`/`headLines`/`tailLines`，分支外再统一计算 `removed`/`unit`，最后按方向拼装 `content`**（`let content` + `if/else if/else`）。语义等价，规避了 TDZ，且更容易静态走查「不越双限、无重复行」。
- **差异 B（`Options.direction` 类型）**：plan §3.2 文本仍写 `direction?: "head" | "tail"`，但策略表 `direction` 需含 `"middle"`，且为让调用方也能显式传 middle，将 `Options.direction` 放宽为 `"head" | "tail" | "middle"`。属安全拓宽，不影响既有调用方。
- **无冲突项**：未发现 plan 与文件实际结构相冲突之处（常量区、`Options`、`output()` 顶部、`write()` 位置均与 plan 描述一致）。原 head/tail 两分支逻辑逐字保留，仅外层包了 `if/else if/else`。

---

## 6. 静态核对（无运行，逐条）

- 单文件：仅 `truncate.ts` 改动。
- 无新 npm 依赖：仅 import `node:crypto`（Node 内置）。
- 导出不变：`MAX_LINES/MAX_BYTES/DIR/GLOB`、`Options`、`Interface`、`Service`、`node`、`Truncate` 全部保留。
- 签名/返回不变：`Interface.output` 签名、`Result` 联合、`{content,truncated:false}` / `{content,truncated:true,outputPath}` 形态未变。
- 向后兼容：不传 `toolID` → `direction="head"`、`maxLines/maxBytes=limits()` → 与原始 `output()` 顶部取值逐字节等价。
- 去重契约：`write` 仍用 `ToolID.ascending()`，文件名前缀 `tool_` 不变 → `cleanup` 过滤仍命中。
- 括号/语法：通读全文，`if/else if/else`、`for`、`Effect.gen`、`Layer.effect` 括号配对；`direction` 三分支全覆盖。

---

## 7. 已知风险（沿用 plan，未放大）

- **R1（opt-in）**：T2 禁改 `tool.ts`，`toolID` 暂不会由调用方传入，`TRUNCATION_STRATEGIES` 默认路径不命中。要真正按工具生效，需后续在 `tool.ts:135` 把 `{}` 改为 `{ toolID: id }`（超出本任务）。
- **R2**：`middle` 已做头尾重叠归一，静态走查确认不越 `maxLines`/`maxBytes`、无重复行。
- **R4**：去重缓存为进程内 `Map`，不跨重启；文件名契约不变，`cleanup` 与既有读取不受影响。
