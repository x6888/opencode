# T2 优化计划：truncate.ts 差异化截断策略 + 内容去重

> 子Agent角色：**规划者（流程 4.2）**。本文档**只规划、不改码**。
> 改动收敛于单文件：`packages/opencode/src/tool/truncate.ts`（已 Read 最新内容，见下引用）。
> 环境：无构建/运行能力，验证仅限静态/结构核对。
> 对齐目标：主Agent 已确认的 T2 任务与 5 条验收标准。

---

## 0. 范围与约束（红线）

- **只改 `truncate.ts` 单文件**：不修改 `tool.ts` / `schema.ts` / `config` 等任何其它文件。
- **无新依赖**：仅允许使用 Node.js 标准库（`node:crypto` 属标准库，非 npm 依赖）；如需新配置一律用**模块级常量默认**。
- **保留导出与调用方语义**：`Interface`（cleanup/write/output/limits）、`Service`、`Result`、`Options`、`MAX_LINES/MAX_BYTES/DIR/GLOB`、返回的 `content/truncated/outputPath` 形态全部保持兼容。
- **行为可预期**：未传 `toolID` 时行为必须与当前实现逐字节等价（向后兼容的硬要求）。

---

## 1. 优化目标

1. **差异化截断策略**：用「按工具 id 的策略表」替换当前无差别的 head/tail 单一逻辑；不同工具可配置不同的保留比例（`maxLines`/`maxBytes`）与保留位置（头 `head` / 尾 `tail` / 中间 `middle`）。
2. **内容去重**：相同输出文本不再重复落盘新文件，降低冗余 token / 存储与二次读取成本。
3. 全部自包含于 `truncate.ts`。

---

## 2. 当前实现分析（引用实际函数/结构，行号来自 truncate.ts 最新版）

### 2.1 现状要点
- **常量**（`truncate.ts:12-17`）：`RETENTION = Duration.days(7)`、`MAX_LINES=2000`、`MAX_BYTES=50*1024`、`DIR`、`GLOB`。
- **`Options` 接口**（`truncate.ts:21-25`）：`{ maxLines?: number; maxBytes?: number; direction?: "head" | "tail" }` —— 当前只有 `direction`，**没有工具维度**。
- **`output()`**（`truncate.ts:85-141`）：核心函数。
  - L86-89：`resolved = limits()`；`maxLines/maxBytes/direction` 取 `options.* ?? resolved.*`，`direction` 默认 `"head"`。
  - L90-95：按行拆分 + 算 `totalBytes`；未超限直接返回 `{ content, truncated:false }`。
  - L97-122：仅 `head`/`tail` 两种分支的逐行累积（受 `maxLines`+`maxBytes` 双限约束）。
  - L124-140：算 `removed`（行数或字节数）→ `preview` → `write(text)` 落盘全量 → 拼 `hint`（含 `file`）→ 返回 `{ content, truncated:true, outputPath:file }`。
- **`write()`**（`truncate.ts:68-73`）：`file = path.join(TRUNCATION_DIR, ToolID.ascending())` → **每次都生成全新的 `tool_NNNN` 文件**，无任何去重。
- **`cleanup()`**（`truncate.ts:53-66`）：按 `name.startsWith("tool_")` 过滤后，删除早于 `RETENTION` 的文件 → 去重文件名必须**保留 `tool_` 前缀**。

### 2.2 现状痛点（对应主Agent SOURCE_ANALYSIS §1.2）
1. 截断**无差别 head/tail**，不区分工具类型（grep 应留匹配上下文、shell 应留尾部错误/stderr）。
2. 相同内容**每次生成新 `tool_` 文件**，无去重（冗余落盘）。

### 2.3 调用方约束（关键事实）
`tool.ts:135`：`const truncated = yield* truncate.output(result.output, {}, agent)` —— **调用方传的是空 `options: {}`**。
因此在「只改 truncate.ts」的范围内，**`toolID` 只能通过新增的可选 `Options.toolID` 传入**；若调用方不传，则走默认策略（=当前行为）。
> 结论：差异化能力以「opt-in 可选参数」形式落地，默认路径与现版本逐字节一致。把 `tool.id` 真正传进来的接线属于 `tool.ts` 改动，**超出 T2 单文件范围**，列为「建议后续接线」（见 §7），不写入本次实现。

---

## 3. 优化方案（具体改动要点 / 伪码）

### 3.1 新增模块级策略类型与策略表（在常量区，`truncate.ts:16` 附近）

```ts
// 新增：按工具 id 的截断策略；direction 新增 "middle"
type TruncateStrategy = {
  maxLines?: number
  maxBytes?: number
  direction?: "head" | "tail" | "middle"
}

// 模块级常量默认策略表（无需新配置项；如需扩展直接改此表）
const DEFAULT_TRUNCATION_STRATEGY: TruncateStrategy = {
  direction: "head",
}

const TRUNCATION_STRATEGIES: Record<string, TruncateStrategy> = {
  // 示例：shell 类工具保留尾部（错误/stderr 在末尾）
  bash: { direction: "tail" },
  shell: { direction: "tail" },
  // 示例：grep 类保留头部（匹配行靠前，且通常量小，给更小上限）
  grep: { direction: "head", maxLines: 1000 },
  // 示例：read 类长文件保留中间（看首尾上下文最有用）
  read: { direction: "middle" },
  // 预留：edit/diff 等可按需追加
}
```

> 说明：表项可随需要增删；键为工具 id（`"bash"`/`"grep"`/`"read"` 等）。未命中时回退 `DEFAULT_TRUNCATION_STRATEGY`。

### 3.2 扩展 `Options`（向后兼容）

```ts
export interface Options {
  maxLines?: number
  maxBytes?: number
  direction?: "head" | "tail"
  /** 可选：工具 id，用于选取 TRUNCATION_STRATEGIES 中的差异化策略；不传则走默认（=当前行为） */
  toolID?: string
}
```
- 纯**新增可选字段**，现有调用方（`tool.ts` 传 `{}`）不受影响，签名与返回类型不变 → 验收 #4 满足。

### 3.3 策略解析（替换原 L86-89 的无差别取值）

```ts
const output = Effect.fn("Truncate.output")(function* (
  text: string,
  options: Options = {},
  agent?: Agent.Info,
) {
  const resolved = yield* limits()
  const strategy =
    (options.toolID && TRUNCATION_STRATEGIES[options.toolID]) || DEFAULT_TRUNCATION_STRATEGY

  // 优先级：调用方显式 options.*  >  策略表  >  全局 limits() 默认
  const maxLines = options.maxLines ?? strategy.maxLines ?? resolved.maxLines
  const maxBytes = options.maxBytes ?? strategy.maxBytes ?? resolved.maxBytes
  const direction = options.direction ?? strategy.direction ?? "head"
  // ... 其余沿用现有行拆分/总字节计算 ...
})
```
- `options.direction` 仍可被调用方显式覆盖（保持原 `Options.direction` 能力），仅当未传时回落策略表。
- 未传 `toolID` 且无 `options.direction` → `direction="head"`、`maxLines/maxBytes=limits()` → 与原 `L86-89` 完全等价。

### 3.4 新增 `middle` 分支（在 L102-122 的 head/tail 之外）

伪码（保持与原 head/tail 相同的「行数 + 字节双限」约束）：

```ts
if (direction === "middle") {
  // 预算对半分：头半 + 尾半，中间用 "...removed..." 连接
  const headBudgetLines = Math.floor(maxLines / 2)
  const tailBudgetLines = maxLines - headBudgetLines
  const headBudgetBytes = Math.floor(maxBytes / 2)
  const tailBudgetBytes = maxBytes - headBudgetBytes

  // 收头
  for (let h = 0; h < lines.length && out.length < headBudgetLines; h++) {
    const size = Buffer.byteLength(lines[h], "utf-8") + (out.length > 0 ? 1 : 0)
    if (bytes + size > headBudgetBytes) { hitBytes = true; break }
    out.push(lines[h]); bytes += size
  }
  // 收尾（倒序）
  const tail: string[] = []
  let tbytes = 0
  for (let t = lines.length - 1; t >= 0 && tail.length < tailBudgetLines; t--) {
    const size = Buffer.byteLength(lines[t], "utf-8") + (tail.length > 0 ? 1 : 0)
    if (tbytes + size > tailBudgetBytes) { hitBytes = true; break }
    tail.unshift(lines[t]); tbytes += size
  }
  // 头/尾若有重叠（文本极短）则归一，避免重复行
  if (out.length + tail.length > lines.length) {
    out = lines.slice(0, maxLines)   // 整段都没超限，直接取前 maxLines 行
  } else {
    out = out.concat(["", `...${removed} ${unit} truncated...`, ""], tail)
  }
}
```
- `removed` / `unit` 计算复用原 `L124-125` 逻辑（`hitBytes` 时按字节，否则按行）。
- `head`/`tail` 两分支**原样保留**，仅 `middle` 为新增路径。

### 3.5 内容去重（改写 `write()`，`truncate.ts:68-73`）

**采用方案：闭包内「内容哈希 → 已落盘路径」缓存 + 保留 `ToolID.ascending()` 文件名**（最小风险、100% 保留现有文件名契约）。

```ts
import { createHash } from "node:crypto"   // 标准库，非新 npm 依赖

const layer = Layer.effect(Service, Effect.gen(function* () {
  const fs = yield* FSUtil.Service
  // 闭包级去重缓存：contentHash -> 已落盘文件路径（进程生命周期内有效）
  const dedup = new Map<string, string>()

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
  // ... 其余 cleanup/limits/output 不变 ...
}))
```

**为什么选这个方案（对照备选）**
- **保留 `ToolID.ascending()` 文件名**：`cleanup()` 的 `startsWith("tool_")` 过滤、任何对 `tool_NNNN` 顺序/前缀的既有假设都**不变**，风险最低。
- **去重范围**：同一进程（即一次会话）内，重复出现相同大输出（最常见的「重跑同一条命令」）将复用同一文件，不再重复落盘 → 满足「避免重复持久化」的主场景。
- **备选方案（更激进，文中记录但不默认采用）**：直接以 `tool_<sha256前16位>` 命名文件，使去重跨进程重启也成立、且实现更简单（无需 `Map`）。代价是改变了 `tool_NNNN` 顺序命名契约——需全仓静态确认 `ToolID.ascending` 的 `tool_` 前缀命名不被其它代码解析依赖（见 §6 风险）。T2 默认采用更稳的「闭包缓存 + 保留原名」方案；若改码者确认无契约依赖，可换备选。

> 注：`createHash` 来自 `node:crypto`，属 Node 内置模块，**不新增 package.json 依赖**，满足「无新依赖」。若希望零 import，可退化为文件内联字符串哈希（FNV/cyrb53），代价是碰撞概率略高；本计划以 `node:crypto` 为准。

### 3.6 不改的部分（明确）
- `Result` 类型、返回对象字段（`content/truncated/outputPath`）、`hint` 文案逻辑。
- `cleanup()` / `limits()` 逻辑与签名。
- `Service` / `Interface` / `node` 导出。
- `MAX_LINES`/`MAX_BYTES`/`DIR`/`GLOB` 常量（保留作默认值）。

---

## 4. 预期收益

1. **差异化**：grep 类给更小上限、shell 类留尾部、read 类留中间，截断结果更贴合工具语义，回灌模型的预览信息密度更高。
2. **去重**：会话内重复相同大输出不再重复写盘，减少磁盘占用与后续二次读取的 token 成本（主Agent SOURCE_ANALYSIS §1.2 痛点 2 直接消除）。
3. **零外部依赖、单文件自包含**：回归与审计成本低；默认路径与现版逐字节等价，无行为回退风险。

---

## 5. 风险与回退

### 风险
- **R1（最关键）**：策略表是 opt-in。由于 T2 禁改 `tool.ts`，`toolID` 暂不会由调用方传入，`TRUNCATION_STRATEGIES` 在默认路径下**不会被命中**。即「差异化」能力已具备但未接线。影响：验收 #1 的「替换无差别逻辑」在行为层表现为「提供机制 + 默认等价」，需明确这是单文件约束下的正确边界。回退/增强：后续在 `tool.ts:135` 把 `{}` 改为 `{ toolID: id }` 即可全面启用（属另一任务）。
- **R2**：`middle` 分支的「头/尾预算对半 + 重叠归一」逻辑较易出界（短文本、头尾重叠）。需静态走查确保 `out` 不含重复行、不越 `maxLines`/`maxBytes`。
- **R3（仅当选备选方案时）**：若改码者采用 `tool_<hash>` 文件名，需确认 `ToolID.ascending` 的顺序命名不被其它模块解析依赖（全仓 grep 验证）。
- **R4**：去重缓存为进程内 `Map`，不跨重启；但文件名契约不变，不影响 `cleanup` 与既有读取。

### 回退
- 删除 `TRUNCATION_STRATEGIES` / `DEFAULT_TRUNCATION_STRATEGY` / `Options.toolID` 与策略解析、`middle` 分支、`write()` 去重块，恢复 `write()` 为原始 `ToolID.ascending()` 直写，即完全回到当前实现，不影响任何调用方。

---

## 6. 逐条验收对照表（对齐主Agent 5 条）

| # | 验收标准 | T2 落点 | 是否达成 |
|---|---|---|---|
| 1 | 引入按工具 id 的策略表，替换无差别 head/tail；可配置比例/位置（头/尾/中间） | §3.1 策略表 + §3.2 `Options.toolID` + §3.3 策略解析（options>表>默认）+ §3.4 `middle` 分支 | ✅（机制具备；默认路径等价于原 head，见 R1） |
| 2 | 相同内容避免重复持久化 | §3.5 `write()` 闭包哈希缓存，复用已有 `tool_NNNN` 文件，跳过重复落盘 | ✅（会话内去重；文件名契约不变） |
| 3 | 仅 `truncate.ts` 单文件、无新依赖、TS 风格/import/命名一致 | 仅本文件；`node:crypto` 为标准库；新增常量/类型沿用 `UPPER_CASE` 与现有风格 | ✅ |
| 4 | 保留现有导出与调用方语义（截断后仍返回可用结果、行为可预期） | `Options` 仅加可选字段；未传 `toolID` 时 `direction/maxLines/maxBytes` 与现版一致；`Result`/`Interface`/`Service` 不变 | ✅ |
| 5 | 附 before/after 行为说明与最小静态核对方式 | 见 §3 伪码 + `steps.md` 的静态核对 + 下方 before/after 摘要 | ✅ |

### Before / After 行为摘要（无需运行）
- **默认（不传 toolID，如当前 `tool.ts` 调用）**：与现版完全一致 → `head` 截断、`limits()` 默认上限、每次 `output` 仍写新 `tool_NNNN`。**新增**：若本次 `text` 与本次会话内某次已落盘 `text` 相同，则复用该文件（去重），`outputPath` 指向同一文件。
- **传 `toolID:"grep"`**：以 `head` + `maxLines=1000` 截断（更小上限）。
- **传 `toolID:"bash"`**：以 `tail` 截断（保留尾部 stderr/错误）。
- **传 `toolID:"read"`**：以 `middle` 截断（头半 + 尾半 + 中间省略标记）。
- **返回形态**：`{ content, truncated:true, outputPath }` 或 `{ content, truncated:false }` 不变；`hint` 不变。

---

## 7. 建议后续接线（超出 T2 单文件范围，仅记录）
在 `tool.ts:135` 将 `truncate.output(result.output, {}, agent)` 改为
`truncate.output(result.output, { toolID: id }, agent)`，
即可让 `TRUNCATION_STRATEGIES` 真正按工具生效（启用验收 #1 的全部行为收益）。此改动属 `tool.ts`，不在 T2 内。
