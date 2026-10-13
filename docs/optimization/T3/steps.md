# T3 执行步骤清单（instruction.ts 指令装配缓存：TTL / mtime）

> 供下一个子Agent（改码者）逐步执行。每步标注**预期产物**与**如何静态核对**（本环境无法运行，仅结构/逻辑核对）。
> 全程只动 `packages/opencode/src/session/instruction.ts` 单文件，不新增依赖、不改其他文件、不改导出签名与 `system()`/`resolve()`/`clear()` 函数体。

---

## 步骤 ①：扩展 `effect` import 加入 `Option`（L5）

- **操作**：把
  ```ts
  import { Effect, Layer, Context } from "effect"
  ```
  改为
  ```ts
  import { Effect, Layer, Context, Option } from "effect"
  ```
- **预期产物**：L5 出现 `Option`；其余 import（L1–L15）不变。
- **静态核对**：
  - Grep 确认 `Option` 仅来自 `effect`（同项目已有，见 `tool/truncate.ts:93` 用法），未引入任何新包名。
  - 确认无重复 import 冲突。

## 步骤 ②：新增模块级缓存常量与容器（置于 L16 import 之后、`extract` 函数 L17 之前）

- **操作**：插入
  ```ts
  // ---- T3 指令内容缓存（进程内，单文件自包含，无新依赖） ----
  const FILE_CACHE_TTL_MS = 30_000
  const REMOTE_CACHE_TTL_MS = 60_000
  const fileContentCache = new Map<
    string,
    { value: string; mtime: number; expires: number }
  >()
  const urlContentCache = new Map<
    string,
    { value: string; expires: number }
  >()
  ```
- **预期产物**：文件顶部出现 2 个 TTL 常量 + 2 个 `Map`（`fileContentCache` / `urlContentCache`），初始为空。
- **静态核对**：
  - 确认 4 个符号均为模块级、无外部引用；类型签名与 §3.1 一致。
  - 确认 `path` 已在 L3 import，后续 `path.resolve` 可用。

## 步骤 ③：改写 `read` 加本地文件缓存（替换 L91-93）

- **操作**：把
  ```ts
  const read = Effect.fnUntraced(function* (filepath: string) {
    return yield* fs.readFileString(filepath).pipe(Effect.catch(() => Effect.succeed("")))
  })
  ```
  替换为 plan.md §3.2 的带缓存版本（`key = "file:" + path.resolve(filepath)`；命中且未过 TTL 时 `stat` 比对 mtime；一致则直接返回 `cached.value`；否则 `readFileString` 回源并写入 `{value, mtime, expires}`）。
- **预期产物**：`read` 现在先查 `fileContentCache`，命中且 mtime 一致则跳过重内容读盘；失效时回源并刷新缓存；任何异常路径仍返回 `""`（与原 `Effect.catch(() => Effect.succeed(""))` 语义一致）。
- **静态核对**：
  - 确认 mtime 取自 `Option.getOrUndefined(info.mtime)?.getTime()`，与 `truncate.ts:93-94` 用法一致（`mtime` 为 `Date`）。
  - 确认命中分支**不调用** `readFileString`，仅一次 `stat`（轻量元数据 I/O）。
  - 确认写缓存时 `expires = Date.now() + FILE_CACHE_TTL_MS`（TTL 兜底）。
  - 用 plan.md §7 场景 A/B/C 做逻辑走查：冷启动回源写缓存；未改文件命中跳读；改文件 mtime 变 → 失效回源。

## 步骤 ④：改写 `fetch` 加远程 URL 缓存（替换 L95-103）

- **操作**：把原 `fetch`（L95-103）替换为 plan.md §3.3 的带缓存版本（`key = "url:" + url`；TTL 内命中直接返回 `cached.value`；否则 `http.execute(GET)` + 5s 超时；`!res` 时 `delete(key)` 返回 `""`；成功则写 `{value, expires}`）。
- **预期产物**：`fetch` 在 `REMOTE_CACHE_TTL_MS` 内命中时跳过 HTTP 请求与超时；失败路径与原语义一致（返回 `""` 且不缓存故障）。
- **静态核对**：
  - 确认 `http.execute` / `Effect.timeout(5000)` / `Effect.catch(() => Effect.succeed(null))` 行为与原 L96-99 完全一致。
  - 确认 `!res` 分支执行 `urlContentCache.delete(key)` 后才 `return ""`（失败不缓存）。
  - 用 plan.md §7 场景 B/D/E 走查：TTL 内命中跳网络；超时失败返回 `""` 且不固化。

## 步骤 ⑤：确认“不改动项”保持原样（关键核对）

- **操作**：**不要**修改以下内容，仅核对：
  - `system()`（L155-169）：仍 `Effect.forEach(Array.from(paths), read)` 与 `Effect.forEach(urls, fetch)`，拼字符串逻辑不变。
  - `resolve()`（L179-221）：仍调用 `read(found)`，返回 `{filepath, content}[]` 结构不变。
  - `clear`（L105-108）：仅操作 `claims`，不碰 `fileContentCache`/`urlContentCache`。
  - `extract`（L17-32）、`Interface`（L34-44）、`Service`（L46）、`loaded`（L227）、`node`（L231-235）、`Instruction` 导出（L237）：全部原样。
- **预期产物**：缓存对 `system`/`resolve`/`clear` 透明；导出与入参/出参类型 0 变化。
- **静态核对**：
  - Grep `fileContentCache|urlContentCache` → 仅出现在步骤 ②/③/④ 定义与赋值处，未出现在 `system`/`resolve`/`clear` 体内。
  - 确认 `system`/`resolve` 的返回类型与 `Interface`（L34-44）声明一致。

## 步骤 ⑥：最终静态核对（逐条对照验收标准 1–5）

- **操作**：逐项核对下方清单，并保留 plan.md §7 作为 before/after 行为说明。
- **预期产物**：验收对照全部命中，可交付主Agent。
- **静态核对清单**：
  1. ✅ 缓存按来源 key（`file:<path>` / `url:<url>`）建立；本地支持 mtime 失效 + TTL 兜底，远程支持 TTL 失效（对照标准 1，见 §3.1–3.3）。
  2. ✅ 装配优先命中缓存、仅失效回源；命中返回内容与原 `read`/`fetch` 一致，`system`/`resolve` 拼装字符串不变（对照标准 2，见 §3.2–3.3 + §7 场景 B）。
  3. ✅ 仅 `instruction.ts` 单文件；仅 L5 加 `Option`（同模块，无新包）；命名沿用 UPPER_SNAKE（对照标准 3）。
  4. ✅ `Service`/`loaded`/`node`/`Instruction`/`Interface` 导出与 `system`/`resolve`/`clear` 入参出参全保留（对照标准 4，见 §3.5 + 步骤 ⑤）。
  5. ✅ 已附 before/after 走查（plan.md §7，含命中/失效/失败/编辑后 7 个场景）与步骤 ①–⑤ 每步静态核对方式（对照标准 5）。

---

## 原子性 / 回退提示
- 每一步可独立 `git diff` 核对；若拒绝缓存（如担心风险 1/2 的陈旧窗口），仅回退步骤 ③/④ 即可，步骤 ①/② 的常量/Map 留着无害；全量回退见 plan.md §5（删 §3.1 四个符号 + 还原 `read`/`fetch` 为原始 L91-93/L95-103 + 撤销 L5 的 `Option`）。
- 关键风险点（回传主Agent）：**(a) 缓存一致性/陈旧窗口**——本地靠 mtime 主失效 + 30s TTL 兜底，远程靠 60s TTL，均已设上限；**(b) 远程 URL 缓存安全性**——失败不缓存、TTL 短，避免陈旧指令长期滞留。
