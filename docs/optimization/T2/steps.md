# T2 执行步骤清单（原子步骤 · 改码者按序执行）

> 配套：`optimization/T2/plan.md`。本环境无构建/运行能力，**每步产物仅通过静态/结构核对**，不执行编译或测试。
> 所有改动**仅限** `packages/opencode/src/tool/truncate.ts`。

---

## 步骤总览
| 步 | 内容 | 风险等级 |
|---|---|---|
| S1 | 新增 `node:crypto` 的 `createHash` import | 低 |
| S2 | 新增 `TruncateStrategy` 类型 + `DEFAULT_TRUNCATION_STRATEGY` + `TRUNCATION_STRATEGIES` 策略表（模块级常量） | 低 |
| S3 | 扩展 `Options` 接口，加可选 `toolID?: string` | 低 |
| S4 | 改写 `output()` 顶部：按 `options.toolID` 查策略表并解析 `maxLines/maxBytes/direction`（优先级：options > 表 > limits） | 中 |
| S5 | 在 `output()` 截断分支新增 `middle` 方向（头半+尾半+省略标记，含重叠归一） | 中 |
| S6 | 改写 `write()`：加闭包级「内容哈希→已落盘路径」去重缓存，命中且文件存在则复用 | 中 |
| S7 | 通读全文，确认导出/签名/返回形态不变，做全局静态核对 | 中 |

---

## S1 — 新增 `createHash` import
**改动位置**：`truncate.ts:1-10` 顶部 import 区。
**预期产物**：
```ts
import { createHash } from "node:crypto"
```
加在现有 import 之间（建议紧随 `path from "path"` 之后），其余 import 不动。
**静态核对方法**：
- `Grep "createHash" truncate.ts` → 应出现且来自 `node:crypto`。
- 确认未新增任何 `package.json` 依赖（`node:crypto` 为 Node 标准库）：`Read root/package.json` 的 dependencies 无 `crypto` 新增项。
- 确认 import 语句无语法残缺（括号/引号配对）。

## S2 — 新增策略类型与策略表
**改动位置**：`truncate.ts:16`（`DIR/GLOB` 之后）附近，作为模块级常量。
**预期产物**：
- 类型 `TruncateStrategy = { maxLines?: number; maxBytes?: number; direction?: "head"|"tail"|"middle" }`
- `DEFAULT_TRUNCATION_STRATEGY = { direction: "head" }`
- `TRUNCATION_STRATEGIES: Record<string, TruncateStrategy>` 含若干示例键（`bash/shell`→tail、`grep`→head+maxLines:1000、`read`→middle）。
**静态核对方法**：
- 表键均为字符串字面量；值仅含 `maxLines/maxBytes/direction` 三字段。
- `direction` 取值仅限 `"head"|"tail"|"middle"`，无拼写错误。
- 未命中键时回退 `DEFAULT_TRUNCATION_STRATEGY`（在 S4 核对）。
- 新增常量命名风格与现有 `MAX_LINES` 等 `UPPER_CASE` 一致。

## S3 — 扩展 `Options`
**改动位置**：`truncate.ts:21-25` `Options` 接口。
**预期产物**：在原三字段后追加 `toolID?: string`（含一行注释说明为可选、用于选取策略表）。
**静态核对方法**：
- 原 `maxLines/maxBytes/direction` 字段全部保留、类型不变。
- `toolID` 为可选（`?`），故 `tool.ts:135` 的 `truncate.output(result.output, {}, agent)` 传 `{}` 仍合法（TS 可选属性兼容）。
- `Interface.output` 签名 `output: (text, options?, agent?) => ...` 未改；`Result` 类型未改。

## S4 — 策略解析（替换原 L86-89 取值）
**改动位置**：`output()` 内 `L86-89`。
**预期产物**：
```ts
const resolved = yield* limits()
const strategy = (options.toolID && TRUNCATION_STRATEGIES[options.toolID]) || DEFAULT_TRUNCATION_STRATEGY
const maxLines = options.maxLines ?? strategy.maxLines ?? resolved.maxLines
const maxBytes = options.maxBytes ?? strategy.maxBytes ?? resolved.maxBytes
const direction = options.direction ?? strategy.direction ?? "head"
```
**静态核对方法**：
- 当 `options` 为 `{}`（当前 `tool.ts` 调用）：`options.toolID` 为 `undefined` → `strategy = DEFAULT`；`options.direction` 为 `undefined` → `direction = "head"`；`maxLines/maxBytes = resolved.*` → 与原始 `L86-89` **逐字节等价**。
- 优先级顺序正确：显式 `options.*` 最高，其次策略表，最后 `limits()`。
- 行拆分 `text.split("\n")` 与 `totalBytes` 计算（原 L90-91）保持不动。

## S5 — 新增 `middle` 分支
**改动位置**：`output()` 截断段（原 L102-122 的 `if (direction === "head") {...} else {...}` 改为 `if/else if/else` 三段，新增 `else if (direction === "middle")`）。
**预期产物**：实现「头半行 + 中间省略标记 + 尾半行」拼接；复用原 `removed`/`unit`（L124-125）与 `hitBytes` 逻辑；对极短文本做头尾重叠归一（避免重复行、不越 `maxLines`/`maxBytes`）。
**静态核对方法**：
- `head`/`tail` 两分支逻辑与原 `L102-112` / `L113-122` **逐字一致**，仅结构外层加了 `else if`。
- `middle` 分支内最终 `out` 行数 ≤ `maxLines`，字节数 ≤ `maxBytes`（逐行累加时复用 `size`/`bytes` 约束，双限生效）。
- `middle` 分支最终拼入 `...${removed} ${unit} truncated...` 标记，与原 head/tail 的提示形态一致。
- 重叠归一：当 `headLen + tailLen > lines.length` 时退化为取前 `maxLines` 行，确保无重复行。

## S6 — `write()` 去重
**改动位置**：`layer` 内（`truncate.ts:48-73`），在 `Effect.gen` 顶部新增 `const dedup = new Map<string, string>()`；改写 `write`（原 L68-73）。
**预期产物**：
```ts
const dedup = new Map<string, string>()
const write = Effect.fn("Truncate.write")(function* (text: string) {
  const h = createHash("sha256").update(text).digest("hex")
  const cached = dedup.get(h)
  if (cached) {
    const exists = yield* fs.stat(cached).pipe(Effect.map(() => true), Effect.catch(() => Effect.succeed(false)))
    if (exists) return cached
  }
  const file = path.join(TRUNCATION_DIR, ToolID.ascending())  // 文件名契约不变
  yield* fs.ensureDir(TRUNCATION_DIR).pipe(Effect.orDie)
  yield* fs.writeFileString(file, text).pipe(Effect.orDie)
  dedup.set(h, file)
  return file
})
```
**静态核对方法**：
- `write` 返回值类型仍为 `string`（路径），`output()` 中 `const file = yield* write(text)` 不受类型影响。
- 文件名仍为 `path.join(TRUNCATION_DIR, ToolID.ascending())` → 前缀 `tool_` 不变 → `cleanup()` 的 `startsWith("tool_")` 过滤不受影响（`truncate.ts:56`）。
- `fs.stat` 用 `Effect.catch` 吞掉异常返回 `false`，不会因缓存文件被清理而抛错（与 `cleanup` 风格一致）。
- 仅新增闭包变量 `dedup`，未改 `cleanup/limits/output` 的可见行为；`dedup` 不影响跨调用语义（同名内容复用路径是可预期优化）。

## S7 — 全局静态核对（收尾）
**预期产物**：一份确认清单，证明满足 5 条验收标准且未破坏既有契约。
**静态核对方法（逐项）**：
1. **单文件**：`Git diff --stat` 或人工确认仅 `truncate.ts` 变动；其他文件未触碰。
2. **无新依赖**：`root/package.json` dependencies/devDependencies 无新增条目；仅 `node:crypto`（标准库）import。
3. **导出不变**：`export const MAX_LINES/MAX_BYTES/DIR/GLOB`、`export interface Options/Interface`、`export class Service`、`export const node`、`export * as Truncate` 全部保留。
4. **签名/返回不变**：`Interface.output` 签名、`Result` 联合类型、返回 `{content,truncated:false}` 与 `{content,truncated:true,outputPath}` 三字段形态未变。
5. **向后兼容**：不传 `toolID` → `direction="head"`、`maxLines/maxBytes=limits()` → 与原始实现等价（对照 `plan.md` §3.3 与 Before/After）。
6. **去重契约**：`write` 仍用 `ToolID.ascending()`，文件名前缀 `tool_` 不变 → `cleanup` 过滤仍命中。
7. **风格一致**：新增常量 `UPPER_CASE`、类型/注释风格与现有代码一致；无 `any` 滥用（`Options.toolID` 为 `string`）。
8. **括号/语法**：通读全文，所有 `if/else if/else`、`for`、`Effect.gen`、`Layer.effect` 括号配对；`direction` 三分支覆盖全枚举。

---

## 关键风险提醒（改码者必读）
- **R1（最重要）**：策略表为 opt-in。T2 禁改 `tool.ts`，故 `toolID` 暂不会被调用方传入，`TRUNCATION_STRATEGIES` 默认路径下不命中——差异化是「机制具备、默认等价」。要真正按工具生效，需后续在 `tool.ts:135` 传入 `{ toolID: id }`（超出本任务）。
- **R2**：`middle` 分支务必静态走查「不越双限、无重复行」（见 S5 核对）。
- **R3（仅当选备选文件名方案时）**：若改码者用 `tool_<sha256>` 命名而非闭包缓存，须全仓 grep `ToolID.ascending` 与 `tool_` 字面量解析，确认无外部依赖命名契约。本计划默认用「闭包缓存 + 保留原名」方案，规避此风险。
