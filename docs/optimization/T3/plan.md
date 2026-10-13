# T3 优化计划：instruction.ts 指令装配缓存（TTL / mtime）

> 子Agent角色：规划者（流程 4.2）。本文档**只规划、不改码**。所有改动收敛于单文件 `packages/opencode/src/session/instruction.ts`。
> 本环境无构建/运行能力，验证仅限静态/结构核对。
> 对齐目标：主Agent 已确定 T3 任务 = `session/instruction.ts` 指令装配**缓存（TTL / mtime）**（算法优化）。

---

## 1. 优化目标

为指令内容读取引入**进程内缓存层**，消除源码分析中指出的“跨消息重复读取 AGENTS.md 等指令文件、远程/磁盘读取无缓存，导致重复 I/O 与潜在延迟”问题：

1. **本地指令文件**（如 `AGENTS.md` / `CLAUDE.md` / `CONTEXT.md` 及 `config.instructions` 指向的本地路径）：以 `file:<resolved-path>` 为 key 缓存内容，并以**文件 mtime 为主失效信号**、TTL 为兜底失效。
2. **远程指令 URL**（`config.instructions` 中的 `http(s)://` 项）：以 `url:<raw-url>` 为 key 缓存内容，仅以 **TTL** 失效（远程无 mtime 概念）。
3. 装配指令时（`system()` / `resolve()`）优先命中缓存，仅在缓存失效时回源读取；**最终返回的指令内容语义不变**（缓存只替换 I/O 来源，不改变字符串内容）。

---

## 2. 当前实现分析（基于最新源码，引用实际函数/行号）

文件：`packages/opencode/src/session/instruction.ts`（237 行）

- **L91-93** `read(filepath)`：`yield* fs.readFileString(filepath)`，**每次调用都回源读盘**，无任何缓存。被 `system()`（L162 `Effect.forEach(Array.from(paths), read)`）与 `resolve()`（L212 `read(found)`）调用。
- **L95-103** `fetch(url)`：`http.execute(GET)` + 5s 超时，**每次都发起远程请求**，无缓存。被 `system()`（L163 `Effect.forEach(urls, fetch)`）调用。
- **L155-169** `system()`：对本地路径集合 `paths` 并发 `read`（concurrency:8）、对远程 `urls` 并发 `fetch`（concurrency:4），拼成 `Instructions from: ${item}\n${content}` 数组返回。
- **L179-221** `resolve()`：从被读文件向上遍历目录，对每个找到的指令文件调用 `read(found)` 注入消息；用 `claims` Map 保证“每消息每目录只注入一次”。
- **L70-77** `state`（`InstanceState`）：仅跟踪 `claims`（已注入集合），**不含内容缓存**。
- **L46 / L227 / L231 / L237** 导出项：`Service`、`loaded`、`node`、命名空间 `Instruction`、`Interface` —— 均须**保持不变**。

**问题定位**（对应 T3 任务现状）：
1. `read()` 跨消息/跨 `resolve` 遍历对**同一指令文件重复 `readFileString`**，无去重 I/O。
2. `fetch()` 对**同一远程 URL 每次 `system()` 都重新请求**（含 5s 超时等待），重复网络延迟。
3. 无 mtime / TTL 失效机制，无法感知文件变更或避免陈旧。

**可用基础设施（已确认，无需新增）**：
- `FSUtil.Service.stat(filepath)` 存在，返回 `{ mtime: Option<Date> } | undefined`（见 `tool/truncate.ts:92-93`：`const mtime = info && Option.getOrUndefined(info.mtime)`，且 `mtime.getTime()` 可用 → mtime 为 `Date`）。
- `effect` 已为依赖（`instruction.ts` L5 已 `import { Effect, Layer, Context } from "effect"`），`Option` 可由同一模块取出，**不引入新包依赖**。

---

## 3. 优化方案（具体代码改动要点 / 伪码）

> 改动范围极小：仅 (a) 顶部新增 4 个模块级常量/Map；(b) `read` 重写加缓存；(c) `fetch` 重写加缓存；(d) L5 import 加 `Option`。(e) `system()` / `resolve()` / `clear` / 导出**均不动**。
> 命名沿用现有风格（UPPER_SNAKE 常量、`camelCase` 变量），TS 风格与现有 import/命名一致。

### 3.1 新增模块级常量与缓存容器（置于 L16 import 之后、`extract` 之前）

```ts
// ---- T3 指令内容缓存（进程内，单文件自包含，无新依赖） ----
// 本地文件：key = "file:<resolved-path>"，主失效 = 文件 mtime 变化，兜底失效 = TTL。
// 远程 URL：key = "url:<raw-url>"，仅 TTL 失效（远程无 mtime 概念）。
const FILE_CACHE_TTL_MS = 30_000     // 本地缓存上限（兜底，防 stat 不可用时长期陈旧）
const REMOTE_CACHE_TTL_MS = 60_000   // 远程缓存寿命（短 TTL 控制陈旧窗口，安全边界）
const fileContentCache = new Map<
  string,
  { value: string; mtime: number; expires: number }
>()
const urlContentCache = new Map<
  string,
  { value: string; expires: number }
>()
```

> 缓存为**模块级**可变 Map（非 `InstanceState`），进程内跨会话/实例共享——指令文件本就是全局共享的，共享缓存正好最大化命中率。体量 = 不同指令文件/URL 数量，极小，无需淘汰。

### 3.2 改写 `read` —— 本地文件缓存（替换 L91-93）

```ts
const read = Effect.fnUntraced(function* (filepath: string) {
  const key = `file:${path.resolve(filepath)}`
  const now = Date.now()
  const cached = fileContentCache.get(key)
  if (cached && now < cached.expires) {
    // 命中且未过 TTL：用 mtime 校验内容是否仍新鲜（stat 比读内容便宜得多）
    const info = yield* fs
      .stat(filepath)
      .pipe(Effect.catch(() => Effect.succeed(undefined)))
    const mtime = info ? Option.getOrUndefined(info.mtime) : undefined
    if (mtime !== undefined && mtime.getTime() === cached.mtime) {
      return cached.value // ✅ 命中：跳过 readFileString，仅一次轻量 stat
    }
    // mtime 变化（或 stat 失败）→ 视为失效，向下回源
  }
  const value = yield* fs.readFileString(filepath).pipe(Effect.catch(() => Effect.succeed("")))
  let mtime = 0
  const info = yield* fs
    .stat(filepath)
    .pipe(Effect.catch(() => Effect.succeed(undefined)))
  const m = info ? Option.getOrUndefined(info.mtime) : undefined
  if (m !== undefined) mtime = m.getTime()
  fileContentCache.set(key, { value, mtime, expires: Date.now() + FILE_CACHE_TTL_MS })
  return value
})
```

- **mtime 为主失效**：文件被编辑 → mtime 变了 → 下一次命中时 stat 比对不等 → 回源重读，保证内容新鲜。
- **TTL 兜底**：即便 stat 异常，条目超过 `FILE_CACHE_TTL_MS` 也强制失效；同时作为内存陈旧硬上限。
- **命中收益**：命中时只做一次 `stat`（元数据，远轻于 `readFileString` 读内容），消除源码分析指出的重复内容 I/O。

### 3.3 改写 `fetch` —— 远程 URL 缓存（替换 L95-103）

```ts
const fetch = Effect.fnUntraced(function* (url: string) {
  const key = `url:${url}`
  const now = Date.now()
  const cached = urlContentCache.get(key)
  if (cached && now < cached.expires) {
    return cached.value // ✅ TTL 内命中，跳过远程请求与 5s 超时等待
  }
  const res = yield* http.execute(HttpClientRequest.get(url)).pipe(
    Effect.timeout(5000),
    Effect.catch(() => Effect.succeed(null)),
  )
  if (!res) {
    urlContentCache.delete(key) // 失败不缓存（避免把瞬时故障固化为空指令）
    return ""
  }
  const body = yield* res.arrayBuffer.pipe(Effect.catch(() => Effect.succeed(new ArrayBuffer(0))))
  const value = new TextDecoder().decode(body)
  urlContentCache.set(key, { value, expires: Date.now() + REMOTE_CACHE_TTL_MS })
  return value
})
```

- **TTL 唯一失效**（远程无 mtime）：默认 60s，控制陈旧窗口；`REMOTE_CACHE_TTL_MS` 可调。
- **失败不缓存**：`!res`（网络/超时）时 `delete(key)` 并返回 `""`，与现状“失败返回空”语义一致，但不把故障写进缓存。

### 3.4 新增加口 `Option`（仅扩展现有 import，不新增包）

```ts
import { Effect, Layer, Context, Option } from "effect"
```
> 仅把 `Option` 加入 L5 已有 import；`effect` 已是项目依赖，无新包、无新文件。

### 3.5 明确不改动项（保持调用方语义）

- `system()`（L155-169）、`resolve()`（L179-221）**函数体不动**——它们仍按原逻辑调用 `read` / `fetch`，缓存对它们是透明的。
- `clear(messageID)`（L105-108）**不动**：其契约是“重置某消息的 `claims` 注入记录”，与内容缓存无关；内容缓存是全局 TTL/mtime 管理，清空它只会引发冗余重读，故不在此清理（语义完全保留）。
- 所有导出（`Service` / `loaded` / `node` / `Instruction` / `Interface`）与入参/出参结构**不变**。

---

## 4. 预期收益

| 维度 | 改前 | 改后 |
|---|---|---|
| 本地指令读取 | 每次 `system()`/`resolve()` 都 `readFileString` 回源 | 命中仅 1 次 `stat`；mtime 未变则零内容 I/O |
| 远程指令请求 | 每次 `system()` 都重新 HTTP GET + 5s 超时 | TTL 内直接返回缓存，跳过网络与超时等待 |
| 失效机制 | 无 | 本地 mtime 为主 + TTL 兜底；远程 TTL |
| 跨消息重复 I/O | 存在（源码分析已指出） | 消除（内容缓存命中） |
| 文件编辑后内容新鲜度 | 每次都最新（但也每次都读） | mtime 变化即回源重读，仍新鲜 |
| 依赖 / 文件范围 | — | 仅 `instruction.ts` 单文件，0 新包依赖 |
| 调用方语义 | — | `system()`/`resolve()`/`clear`/导出均不变 |

---

## 5. 风险与回退策略

**风险 1（缓存一致性 / 陈旧窗口）**：本地文件在 TTL（默认 30s）内被外部修改但 mtime 未变（极罕见，如 `touch` 反向、内容改写但 mtime 精度问题）→ 可能短暂服务旧内容。缓解：`FILE_CACHE_TTL_MS` 已是硬上限，最坏陈旧 ≤ 30s；正常编辑器改写都会更新 mtime，命中时 stat 比对即失效。
**风险 2（远程缓存安全性 / 陈旧）**：远程指令被源站更新后，最长 `REMOTE_CACHE_TTL_MS`（默认 60s）内仍服务旧版。缓解：TTL 故意取短（60s）；若安全敏感可调小（如 10s）。远程内容为指令文本，非凭证/动态数据，短 TTL 风险可控。
**风险 3（并发重复读）**：纯 `Map` 在多个 fiber 同时 miss 同一 key 时可能各读一次（last-writer-wins，内容相同，无正确性问题），仅多一次冗余 I/O，非缺陷。
**风险 4（扩展 `effect` import）**：仅在 L5 加入已存在的 `Option`，不新增包；若实现方担心，可改用 `Effect` 内等价方式取 mtime，但 `Option.getOrUndefined` 与 `truncate.ts` 完全一致，建议保留以保证风格统一。

**回退策略**：改动完全自包含于 `instruction.ts`。回退只需：(1) 删除 §3.1 的 4 个模块级常量/Map；(2) 将 `read`/`fetch` 恢复为 L91-93 / L95-103 原始实现；(3) 撤销 L5 的 `Option` 加入。即可 100% 回到原始实现，不影响任何调用方与导出。

---

## 6. 验收对照表（逐条对照主Agent 5 条标准）

| # | 验收标准 | 本方案是否满足 / 落点 |
|---|---|---|
| 1 | 引入缓存机制：按指令来源（路径/key）缓存已装配内容，并支持失效（TTL 过期或文件 mtime 变化） | ✅ 见 §3.1–3.3：`file:<path>` 缓存用 mtime 主失效 + TTL 兜底；`url:<url>` 缓存用 TTL 失效；二者均按“来源 key”隔离 |
| 2 | 装配时优先命中缓存，仅失效时回源；缓存命中不改变最终返回内容语义 | ✅ §3.2–3.3：命中直接返回缓存 `value`；`system()`/`resolve()` 仍用同一 `value` 拼 `Instructions from: …`，字符串内容不变；`read`/`fetch` 对调用方契约不变 |
| 3 | 仅限 `instruction.ts` 单文件、无新依赖、TS 风格与现有 import/命名一致 | ✅ 仅改 `read`/`fetch` 两函数 + 顶部 4 常量/Map + L5 加 `Option`（同模块）；命名沿用 UPPER_SNAKE；无新包、无新文件 |
| 4 | 保留现有导出与调用方语义（返回内容一致、不破坏入参/出参） | ✅ §3.5：`system`/`resolve`/`clear` 不动；`Service`/`loaded`/`node`/`Instruction`/`Interface` 导出全保留；入参/出参类型（如 `resolve` 返回 `{filepath,content}[]`）不变 |
| 5 | 附 before/after 行为说明与最小静态核对方式（含缓存命中/失效走查） | ✅ 见 §7 Before/After 走查 + `steps.md` 每步静态核对项，含命中/失效两条路径 |

---

## 7. Before / After 行为走查（伪测试，无需运行）

**场景 A — 首次 `system()`（冷启动，缓存空）**
- 改前：`read(AGENTS.md)` 真实 `readFileString`；`fetch(url)` 真实 HTTP GET。
- 改后：`fileContentCache`/`urlContentCache` 均 miss → 回源读 + 写缓存（带 mtime/expires）。内容与改前**逐字节相同**。

**场景 B — 第二条消息再次 `system()`（同一 AGENTS.md 未改）**
- 改前：再次 `readFileString(AGENTS.md)` 回源读盘。
- 改后：`read` 命中 → `stat` 取 mtime 与缓存一致 → 直接返回缓存 `value`，**跳过内容读盘**；`fetch(url)` 若仍在 60s TTL 内 → 直接返回，**跳过 HTTP 请求与 5s 超时**。返回的指令数组与场景 A **完全一致**（仅 I/O 路径不同）。

**场景 C — 用户编辑了 AGENTS.md（mtime 变化）后 `system()`**
- 改前：`readFileString` 读到新内容。
- 改后：`read` 命中但因 `stat` 的 mtime ≠ 缓存 mtime → 判定失效 → 回源 `readFileString` 拿新内容、刷新缓存。返回**新内容**，与改前一致 ✅（mtime 保证新鲜）。

**场景 D — 远程 URL 源站更新，但仍在 60s TTL 内**
- 改后：`fetch` 命中 TTL → 返回旧缓存内容（陈旧 ≤ 60s）。属预期风险 2，TTL 上限已约束窗口；超时后自动回源拿到新内容。

**场景 E — `fetch` 超时/失败（`!res`）**
- 改前：返回 `""`。
- 改后：`delete(key)` 且不写缓存，返回 `""` → **语义与改前完全一致**，且故障不被固化进缓存（恢复后下次正常回源）。

**场景 F — `clear(messageID)` 被调用**
- 改前/改后：仅删除该消息的 `claims` 记录；内容缓存不受影响（本就全局共享、TTL/mtime 管理）。调用方行为不变 ✅。

**场景 G — `context === 0` / `Flag.OPENCODE_DISABLE_PROJECT_CONFIG` 等既有分支**
- `systemPaths()` 决定 `paths`/`urls` 集合的逻辑完全未动；缓存只影响“按给定 path/url 取内容”这一步，对分支判定零影响 ✅。
