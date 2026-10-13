# T3 验证报告（验证者 · 流程 4.4）

> 验证范围：仅静态/结构核对（本环境无 build/run）。
> 核对文件：`packages/opencode/src/session/instruction.ts`（改后，282 行）、`plan.md`、`steps.md`、`implementation.md`。
> 角色：仅验证，未修改任何代码。

---

## 逐条验收核对

### 标准 1：引入缓存机制，按来源（路径/key）缓存，支持失效（TTL 过期或文件 mtime 变化）

**结论：✅ PASS**

证据（instruction.ts）：
- L23–30：定义两个按来源隔离的缓存容器
  - `fileContentCache`（key = `"file:<resolved-path>"`，存储 `{ value, mtime, expires }`）
  - `urlContentCache`（key = `"url:<raw-url>"`，存储 `{ value, expires }`）
- 本地失效双通道：
  - **mtime 主失效**：L107 `key = \`file:${path.resolve(filepath)}\``；L109–118 命中且未过 TTL 时 `fs.stat` 取 mtime（L113 `Option.getOrUndefined(info.mtime)?.getTime()`）与 `cached.mtime` 比对（L114 `mtime === cached.mtime`），不等则视为失效向下回源。
  - **TTL 兜底失效**：L124 写缓存 `expires = Date.now() + FILE_CACHE_TTL_MS`；L110 `now < cached.expires` 判定 TTL，过期即回源（L119–125）。
- 远程失效单通道（TTL）：
  - L129 `key = \`url:${url}\``；L131–134 `cached && now < cached.expires` 命中则返回，否则回源；L145 写 `expires = Date.now() + REMOTE_CACHE_TTL_MS`。

说明：缓存明确区分本地文件（mtime+TTL）与远程 URL（仅 TTL，远程无 mtime 概念），符合 plan.md §3.1 设计，按"来源 key"隔离。

---

### 标准 2：装配时优先命中缓存，仅失效时回源；命中不改变最终返回内容语义

**结论：✅ PASS**

证据（instruction.ts）：
- 装配入口未动，`system()` L206 `Effect.forEach(Array.from(paths), read)`、L207 `Effect.forEach(urls, fetch)`；`resolve()` L256 `read(found)` —— 缓存对调用方透明。
- 命中路径返回的内容即**曾经回源读取的内容**：
  - `read` 命中（L114 成立）→ `return cached.value`（L115），该值即上次 `readFileString` 的结果（L119 写入）。
  - `fetch` 命中（L132 成立）→ `return cached.value`（L133），即上次 HTTP 响应体解码值（L144 写入）。
- 内容语义不变性保证：
  - 文件变更由 mtime 比对拦截（L114），内容被改写后 mtime 必然变化 → 判定失效回源（L119）拿新内容，与改前"每次都最新"一致。
  - 命中分支不对内容做任何变换，仅原样返回；`system()`/`resolve()` 拼装 `Instructions from: …` 逻辑（L210–211、L258）未变。
- 退化安全：文件无 mtime（stat 失败/无 mtime 字段）时，L113 `mtime===undefined` → L114 条件不成立 → 落入回源（L119），仅"无命中收益"但**内容始终正确**，无陈旧风险。

说明：命中不改变字符串内容；失效严格回源，最终返回内容语义与改前逐字节一致（见 plan.md §7 场景 A–C）。

---

### 标准 3：改动仅限 `instruction.ts` 单文件、无新 npm 依赖、TS 风格一致

**结论：✅ PASS**

证据（instruction.ts）：
- 单文件：全部新增逻辑均位于本文件内（L17–30 常量/Map、L106–147 `read`/`fetch` 重写、L5 import 扩展）。无新增文件。
- 无新依赖：L5 `import { Effect, Layer, Context, Option } from "effect"` —— `Option` 来自**已有依赖 `effect`**（同模块其他 import 相邻），未新增任何 npm 包；其余 import（L1–L16）未变。
- TS 风格一致：
  - 常量命名沿用现有 UPPER_SNAKE（如 `FILE_CACHE_TTL_MS`，与仓库既有常量风格一致）。
  - 变量 camelCase（`fileContentCache`、`cached`、`mtime`），与现有 `read`/`fetch` 局部变量风格一致。
  - 沿用 `Effect.fnUntraced`、`Effect.catch(() => Effect.succeed(...))`、`Option.getOrUndefined` 等既有惯用法（与 `tool/truncate.ts:93` 用法一致）。

说明：验证局限——本环境无 git/build，无法对仓库其他文件做 diff 全局确认"仅此文件改动"；但**文件内**无任何新包引入或新文件引用，单文件收敛在源码层面成立。

---

### 标准 4：保留现有导出与调用方语义（返回内容一致、入参/出参不变）

**结论：✅ PASS**

证据（instruction.ts）：
- 导出项全部保留且签名未变：
  - `Interface`（L49–59）：`clear` / `systemPaths` / `system` / `find` / `resolve` 签名与改前一致。
  - `Service`（L61）、`loaded`（L271–273）、`node`（L275–279）、`export * as Instruction`（L281）均在。
- `system()`（L199–213）：返回类型 `Effect.Effect<string[], FSUtil.Error>`，拼装结构与改前一致，仅内部 `read`/`fetch` 行为变化。
- `resolve()`（L223–265）：返回类型 `Effect.Effect<{ filepath: string; content: string }[], FSUtil.Error>`，L256 `read(found)` 返回 `{ filepath, content: \`Instructions from: …\` }`，结构零变化。
- `clear`（L149–152）：仅操作 `claims`，不触碰缓存容器，契约不变。
- 缓存容器作用域隔离：Grep 核对 `fileContentCache|urlContentCache` 仅出现于 L23–30（定义）与 L106–147（`read`/`fetch` 体内），**未**出现在 `system`/`resolve`/`clear` 函数体（L149–265）。

说明：入参/出参、导出集合、调用方契约全部保留，缓存完全透明。

---

### 标准 5：附 before/after 行为说明与最小静态核对（implementation.md 中应有）

**结论：✅ PASS**

证据：
- `implementation.md` §3（L82–92）提供完整的 Before/After 行为对照表，覆盖冷启动、二次 `system()`、编辑文件、远程 TTL 内、远程失败、clear、既有分支共 7 个场景。
- `implementation.md` §4（L94–98）给出最小静态核对方式：整文件语法/括号配对复查 + Grep 确认缓存容器仅限定义与 `read`/`fetch` 内部 + `system`/`resolve` 契约零变化。
- `plan.md` §7（L180–205）进一步提供场景 A–G 伪测试走查（含命中/失效/失败/编辑后路径）；`steps.md` ①–⑥ 每步均标注静态核对项。

说明：before/after 说明与静态核对清单齐备，符合要求。

---

## 优化闭环判定

**达成 ✅**

五条验收标准全部 PASS，且无代码修改（验证者未改码）。计划（plan.md）→ 代码（instruction.ts）→ 验收标准（本文件逐条核对）三环闭合：
- 计划中的缓存设计（mtime 主失效 + TTL 兜底 / 远程 TTL / 失败不缓存）已在代码中完整落地；
- 所有"不改动项"（导出、system/resolve/clear、Interface）经验证保持原样；
- before/after 与静态核对文档齐备。

## 遗留/提示（非阻断）

1. **验证局限**：无 git/build 环境，无法 100% 全局确认"仅 instruction.ts 单文件改动、仓库其余文件零改动"。建议在合并前由主Agent 跑一次 `git diff --stat` 确认范围。
2. **已知可接受风险**（plan.md §5 已记录，非缺陷）：
   - 本地 mtime 未变但内容被改写（极罕见）→ 至多陈旧 ≤30s（FILE_CACHE_TTL_MS 硬上限）。
   - 远程源站在 60s 内更新 → 至多陈旧 ≤60s（REMOTE_CACHE_TTL_MS）。
   - 并发同一 key miss 可能各读一次（内容相同，last-writer-wins，无正确性问题）。
3. 以上均已在 plan.md / implementation.md 风险章节说明，属设计内可控范围，不构成闭环未达成。
