# T2 验证报告（验证者 · 流程 4.4）

> 角色：第三个子 Agent（验证者），**仅验证、未改任何代码**。
> 范围：`packages/opencode/src/tool/truncate.ts`（改后）+ `optimization/T2/plan.md` / `steps.md` / `implementation.md`。
> 方法：静态/结构核对（无 build/run 能力）。补充核验了 `sandbox/opencode/root/package.json` 以确认无新依赖。

---

## 逐条验收核对（证据导向）

### 验收 #1 — 引入按工具 id 的截断策略，替换无差别 head/tail；可配置比例/位置（head/tail/middle）
**结论：✅ PASS（机制达成；运行时启用需后续接线，见说明）**

证据：
- `TruncateStrategy` 类型（`truncate.ts:21-25`）：含 `maxLines?` / `maxBytes?` / `direction?: "head" | "tail" | "middle"`，支持「保留比例 + 位置」配置。
- `TRUNCATION_STRATEGIES` 策略表（`truncate.ts:34-42`）：键为工具 id，`bash/shell → tail`、`grep → head + maxLines:1000`、`read → middle`，不同工具可配置不同保留比例/位置。
- `DEFAULT_TRUNCATION_STRATEGY`（`truncate.ts:28-30`）：未命中时的回退（=原 head 行为）。
- 策略解析（`truncate.ts:128-131`）：`options.toolID && TRUNCATION_STRATEGIES[options.toolID] || DEFAULT`；优先级 `options.* > 表 > limits()`。
- `middle` 分支（`truncate.ts:168-204`）：新增中段截断，头半 + 尾半 + 省略标记，并做头尾重叠归一。
- 原 `head`/`tail` 分支（`truncate.ts:148-167`）逻辑保留，仅外层包 `if/else if/else`；`direction` 三分支全覆盖。

说明（局限，非物质性 FAIL）：策略为 **opt-in**，T2 禁改 `tool.ts`，故调用方（`tool.ts:135` 传 `{}`）当前不会传入 `toolID`，`TRUNCATION_STRATEGIES` 在默认路径下不会被命中。这是 plan §7 / R1 已声明的单文件边界，属「机制具备、默认等价」，不视为 T2 验收失败；真正按工具生效需后续在 `tool.ts` 传入 `{ toolID: id }`（独立任务）。

### 验收 #2 — 对相同内容避免重复持久化（去重/复用已有片段）
**结论：✅ PASS**

证据：
- `write()`（`truncate.ts:99-113`）：`createHash("sha256").update(text).digest("hex")` 计算内容哈希，查闭包 `dedup: Map<string,string>`（`truncate.ts:82`）。
- 命中且 `fs.stat` 文件存在 → 直接 `return cached`，跳过重复落盘（`truncate.ts:102-107`）。
- 文件名仍用 `path.join(TRUNCATION_DIR, ToolID.ascending())`（`truncate.ts:108`），`tool_` 前缀契约不变，与 `cleanup()` 的 `startsWith("tool_")` 过滤（`truncate.ts:87`）兼容。

说明：去重范围为**进程内（同一会话）**；跨重启不保留（R4，已记录且可接受，文件名契约不变）。

### 验收 #3 — 仅 truncate.ts 单文件、无新 npm 依赖、TS 风格一致（可用 node:crypto）
**结论：✅ PASS**

证据：
- `node:crypto` 为 Node 标准库：`root/package.json` 的 `dependencies`/`devDependencies`/`catalog` 均无 `crypto` 新增条目（`package.json:33-167` 通查）；`truncate.ts:5` 仅 `import { createHash } from "node:crypto"`。
- 新增类型/常量沿用既有 `UPPER_CASE`（`TRUNCATION_STRATEGIES`、`DEFAULT_TRUNCATION_STRATEGY`、`MAX_LINES` 等同风格），无新增 `any` 滥用（`Options.toolID: string`）。
- 单文件：本次核对仅 `truncate.ts` 出现改动；新增导入均来自既有已用模块（`@opencode-ai/core/fs-util`、`effect`、`node:crypto`、`path`），未引用任何新模块，无法从本文件推断跨文件新增。
  - 残留核对项：`git diff --stat` 全仓确认未触及其它文件，本静态环境未执行（属可补的自动化核对，不影响结论）。

### 验收 #4 — 保留现有导出与调用方语义；未传 toolID 时与改动前逐字节等价
**结论：✅ PASS（截断预览内容逐字节等价；outputPath 因去重可能复用，属预期改进）**

证据（导出/签名保留）：
- 导出齐全：`MAX_LINES`/`MAX_BYTES`/`DIR`/`GLOB`（`truncate.ts:15-18`）、`export type Result`（`truncate.ts:44`）、`export interface Options`（`truncate.ts:46-52`）、`export interface Interface`（`truncate.ts:59-71`）、`export class Service`（`truncate.ts:73`）、`export const node`（`truncate.ts:247`）、`export * as Truncate`（`truncate.ts:249`）。
- `Interface.output` 签名不变（`truncate.ts:66`），`Result` 联合类型形态不变（`{content,truncated:false}` | `{content,truncated:true,outputPath}`）。

证据（未传 toolID 等价性）：
- `options: Options = {}` 默认（`truncate.ts:125`）；`toolID` 为 `undefined` → `strategy = DEFAULT`（direction `"head"`），`options.direction` 为 `undefined` → `direction = "head"`（`truncate.ts:128,131`），`maxLines/maxBytes = resolved = limits()`（`truncate.ts:129-130`）——与改动前取值逐字节一致。
- head 截断分支逻辑（`truncate.ts:148-157`）与改动前一致；未超限时返回 `{content:text, truncated:false}`；超限时 `content = preview + 省略标记 + hint` 与改动前逐字节一致。
- 返回对象的 `content` 字段逐字节等价；`outputPath` 因去重（#2）可能指向会话内已复用的 `tool_NNNN` 文件（内容与原文件相同），属预期行为、不影响调用方语义（拿到的是完整输出的有效路径）。

### 验收 #5 — 附 before/after 行为说明与最小静态核对
**结论：✅ PASS**

证据：
- `implementation.md §3` 提供 Before/After 对照表（默认/ grep / bash / read / 返回形态）。
- `implementation.md §6` 提供逐条静态核对（单文件、无新依赖、导出不变、签名/返回不变、向后兼容、去重契约、括号语法）。
- `plan.md §6` 验收对照表 + Before/After 摘要；`steps.md` 每步 S1–S7 均有静态核对方法。实现文档还标注了与 plan 的差异 A/B（TDZ 规避、`Options.direction` 放宽），说明合理。

---

## 优化闭环判定

**达成 ✅**

- 计划（plan.md）→ 代码（truncate.ts）→ 验收标准（5/5 全部 PASS）形成闭环。
- 验收 #1 的「运行时按工具生效」收益受 T2 单文件约束未接线，但已在 plan §7 / R1 明确列为**后续独立任务**（`tool.ts:135` 传 `{ toolID: id }`），不属 T2 失败。

### 若后续需「真正按工具生效」的差距清单（供主 Agent 调度下一轮，非 T2 未达标）
| 缺口 | 位置 | 建议补法 | 是否 T2 责任 |
|---|---|---|---|
| 调用方未传 `toolID`，`TRUNCATION_STRATEGIES` 默认不命中 | `tool.ts:135` `truncate.output(result.output, {}, agent)` | 改为 `truncate.output(result.output, { toolID: id }, agent)` | 否（超出 T2 单文件） |
| 跨进程重启去重不保留 | `truncate.ts` `dedup: Map`（进程内） | 可选改为 `tool_<sha256前16位>` 命名（需先全仓 grep 确认 `ToolID.ascending` 顺序命名无外部解析依赖） | 否（plan 已选更稳方案） |
| 全仓 `git diff --stat` 自动确认仅单文件 | 仓库级 | CI/本地执行 `git diff --stat` | 否（验证增强项） |

> 上述清单为「增强/接线」类，非 T2 验收缺口；T2 本身已闭环。

---

## 一句话结论（返主 Agent）
T2 已达成优化闭环：truncate.ts 引入按工具 id 的策略表+`middle` 分支与内容哈希去重，单文件、无新依赖、未传 toolID 时逐字节等价（5/5 PASS）；仅运行时按工具生效需后续 `tool.ts` 接线（已规划为独立任务，非 T2 缺口）。验证报告：`sandbox/opencode/optimization/T2/verification.md`。
