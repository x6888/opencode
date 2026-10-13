# T3 实现说明：instruction.ts 指令装配缓存（TTL / mtime）

> 子Agent角色：**改码者（流程 4.3）**。本文件为 T3 的实现归档，对应 `optimization/T3/plan.md` 与 `steps.md`。
> 改动**完全收敛于单文件** `packages/opencode/src/session/instruction.ts`，无新 npm 依赖，未破坏任何导出或调用方语义。

## 1. 改动摘要

| 项 | 改动位置 | 内容 |
|---|---|---|
| ① import 扩展 | L5 | `import { Effect, Layer, Context } from "effect"` → 加入 `Option`（同模块，无新包） |
| ② 模块级缓存 | L17–30（import 之后、`extract` 之前） | 新增 `FILE_CACHE_TTL_MS=30_000`、`REMOTE_CACHE_TTL_MS=60_000` 两个常量，及 `fileContentCache`、`urlContentCache` 两个 `Map` |
| ③ `read` 重写 | L106–126 | 本地文件缓存：`key="file:"+path.resolve(filepath)`；命中且未过 TTL 时用 `fs.stat` 取 mtime（`Option.getOrUndefined(info.mtime)?.getTime()`）比对，一致则跳过 `readFileString` 直接返回；否则回源并刷新缓存 |
| ④ `fetch` 重写 | L128–147 | 远程 URL 缓存：`key="url:"+url`；TTL 内命中直接返回；否则 `http.execute` + 5s 超时；`!res` 时 `delete(key)` 返回 `""`（失败不缓存） |
| ⑤ 不改动项 | — | `system()` / `resolve()` / `clear` / `extract` / `Interface` / `Service` / `loaded` / `node` / `Instruction` 导出**全部原样保留** |

## 2. 关键 diff（逻辑层）

### 2.1 import（L5）
```ts
- import { Effect, Layer, Context } from "effect"
+ import { Effect, Layer, Context, Option } from "effect"
```

### 2.2 顶部缓存容器（L17–30）
```ts
// ---- T3 指令内容缓存（进程内，单文件自包含，无新依赖） ----
const FILE_CACHE_TTL_MS = 30_000     // 本地缓存兜底上限
const REMOTE_CACHE_TTL_MS = 60_000   // 远程缓存寿命（短 TTL 控制陈旧窗口）
const fileContentCache = new Map<string, { value: string; mtime: number; expires: number }>()
const urlContentCache = new Map<string, { value: string; expires: number }>()
```

### 2.3 `read`（本地文件，带 mtime + TTL）
```ts
const read = Effect.fnUntraced(function* (filepath: string) {
  const key = `file:${path.resolve(filepath)}`
  const now = Date.now()
  const cached = fileContentCache.get(key)
  if (cached && now < cached.expires) {
    // 命中且未过 TTL：用 mtime 校验内容是否仍新鲜（stat 比读内容便宜得多）
    const info = yield* fs.stat(filepath).pipe(Effect.catch(() => Effect.succeed(undefined)))
    const mtime = info ? Option.getOrUndefined(info.mtime)?.getTime() : undefined
    if (mtime !== undefined && mtime === cached.mtime) {
      return cached.value // ✅ 命中：跳过 readFileString，仅一次轻量 stat
    }
    // mtime 变化（或 stat 失败）→ 视为失效，向下回源
  }
  const value = yield* fs.readFileString(filepath).pipe(Effect.catch(() => Effect.succeed("")))
  let mtime = 0
  const info = yield* fs.stat(filepath).pipe(Effect.catch(() => Effect.succeed(undefined)))
  const m = info ? Option.getOrUndefined(info.mtime)?.getTime() : undefined
  if (m !== undefined) mtime = m
  fileContentCache.set(key, { value, mtime, expires: Date.now() + FILE_CACHE_TTL_MS })
  return value
})
```

### 2.4 `fetch`（远程 URL，带 TTL，失败不缓存）
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
    urlContentCache.delete(key) // 失败不缓存
    return ""
  }
  const body = yield* res.arrayBuffer.pipe(Effect.catch(() => Effect.succeed(new ArrayBuffer(0))))
  const value = new TextDecoder().decode(body)
  urlContentCache.set(key, { value, expires: Date.now() + REMOTE_CACHE_TTL_MS })
  return value
})
```

## 3. Before / After 行为对照

| 场景 | 改前 | 改后 |
|---|---|---|
| 冷启动（缓存空） | `readFileString` / HTTP GET 回源 | 同样回源，但写缓存（带 mtime/expires），**内容逐字节相同** |
| 同文件二次 `system()` | 再次 `readFileString` 读盘 | `read` 命中 → `stat` 比对 mtime 一致 → 返回缓存值，**跳过内容读盘** |
| 编辑了 AGENTS.md（mtime 变） | 读到新内容 | 命中但 mtime ≠ 缓存 → 失效 → 回源重读并刷新，**返回新内容** |
| 远程 URL 仍在 60s TTL 内 | 每次重新 HTTP GET + 5s 超时 | 直接返回缓存，**跳过网络与超时** |
| 远程失败/超时（`!res`） | 返回 `""` | `delete(key)` 且不写缓存，返回 `""`，**语义一致且故障不固化** |
| `clear(messageID)` | 仅清该消息 `claims` | 不变；内容缓存为全局 TTL/mtime 管理，不受影响 |
| 既有分支（`systemPaths`/`context`/`Flag`） | — | 完全未动；缓存只影响“按给定 path/url 取内容”这一步 |

## 4. 验证方式（无 build/run 环境下）

- **静态核对**：已用 Read 复查整文件括号/语法配对正确；`Option` 取自 `effect`（同项目 `tool/truncate.ts:93` 已用相同 `Option.getOrUndefined(info.mtime)` 模式，且 `FSUtil.Service.stat` 返回 `info.mtime: Option<Date>`）。
- **未破坏项核对**：Grep 确认 `fileContentCache`/`urlContentCache` 仅出现于定义（L17–30）与 `read`/`fetch` 内部；未出现在 `system`/`resolve`/`clear` 函数体。所有导出（L49–61、L227–237）及 `Interface` 签名（L49–59）保持不变。
- `system()` 仍 `Effect.forEach(..., read/fetch)`、`resolve()` 仍 `read(found)` 返回 `{filepath,content}[]`，契约零变化。

## 5. 与 plan.md 的一致性 / 冲突说明

- **未发生冲突**。实现严格对齐 `plan.md` §3.1–3.4 与 `steps.md` ①–④；`fs.stat` 与 `Option.getOrUndefined(info.mtime)?.getTime()` 均已在仓库内 `tool/truncate.ts` 验证为有效用法。
- **用户要求的差异点已采纳**：任务要求本地缓存比对使用 `Option.getOrUndefined(info.mtime)?.getTime()`，实现中即采用该精确写法（与 plan 伪码等价）。
- 取值说明：`FILE_CACHE_TTL_MS=30_000` / `REMOTE_CACHE_TTL_MS=60_000`，顶部注释标明可调性（如远程可缩至 10s 以更激进避免陈旧）。
