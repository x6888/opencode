export * as ToolOutput from "./tool-output.js"

import path from "path"
import { createHash } from "node:crypto"
import type { Tool } from "./tool.js"
import { Context, Duration, Effect, Layer, Schedule } from "effect"
import { makeGlobalNode, makeLocationNode } from "@opencode/util/effect/app-node"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { Identifier } from "@opencode/schema/identifier"
import { FileRetention } from "./file-retention.js"
import { State } from "./state.js"

export const MAX_LINES = 2_000
export const MAX_BYTES = 50 * 1024 // 50 KiB
export const RETENTION = Duration.days(7)
export const DIRECTORY = "tool-output"

export const fileName = (timestamp?: number) => "tool_" + Identifier.create(false, timestamp)

/** 截断保留位置：head 保留开头，tail 保留结尾，middle 保留头尾并省略中间 */
export type Direction = "head" | "tail" | "middle"

/** 按工具 id 的差异化截断策略；未配置的字段回退到全局 limits */
export type TruncateStrategy = {
  readonly maxLines?: number
  readonly maxBytes?: number
  readonly direction?: Direction
}

/** 未命中策略表时的回退策略（等价于不传 toolID 的既有行为） */
const DEFAULT_TRUNCATION_STRATEGY: TruncateStrategy = {
  direction: "head",
}

/** 按工具 id 的截断策略表；键为工具 id，未命中回退 DEFAULT_TRUNCATION_STRATEGY */
export const TRUNCATION_STRATEGIES: Record<string, TruncateStrategy> = {
  // shell 类工具：错误与 stderr 通常落在末尾，保留尾部
  bash: { direction: "tail" },
  shell: { direction: "tail" },
  // grep 类工具：匹配行靠前，给更紧的行上限
  grep: { direction: "head", maxLines: 1_000 },
  // read 类工具：长文件保留头尾上下文，省略中间
  read: { direction: "middle" },
}

/** truncate 的可选参数，取值优先级：显式传入 > 按工具 id 的策略表 > 全局 limits */
export type TruncateOptions = {
  readonly maxLines?: number
  readonly maxBytes?: number
  readonly direction?: Direction
  /** 工具 id，用于命中 TRUNCATION_STRATEGIES；不传则走默认策略（= 既有行为） */
  readonly toolID?: string
}

type Result = Tool.NormalizedResult

type Limits = {
  maxLines: number
  maxBytes: number
}

export type Editor = {
  configure: (limits: Partial<Limits>) => void
}

export interface Interface extends State.Transformable<Editor> {
  readonly truncate: (result: Result, options?: TruncateOptions) => Effect.Effect<Result>
  readonly cleanup: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ToolOutput") {}

const cleanup = Effect.fn("ToolOutput.cleanup")(function* (fs: FSUtil.Interface, directory: string) {
  const entries = yield* fs.readDirectory(directory).pipe(
    Effect.map((entries) => entries.filter((entry) => /^tool_[0-9a-f]{12}/.test(entry))),
    Effect.orElseSucceed(() => []),
  )
  yield* FileRetention.cleanup(
    fs,
    entries.map((entry) => path.join(directory, entry)),
    RETENTION,
  )
})

type Selection = {
  /** 按原始顺序保留的行 */
  kept: string[]
  /** middle 的头段；为空表示不做中段省略 */
  head: string[]
  /** middle 的尾段；为空表示不做中段省略 */
  tail: string[]
}

/** 从开头逐行累计，受行数与字节双限约束 */
const takeHead = (lines: string[], maxLines: number, maxBytes: number) => {
  const kept: string[] = []
  let bytes = 0
  for (const line of lines.slice(0, maxLines)) {
    const size = Buffer.byteLength(line, "utf-8") + (kept.length > 0 ? 1 : 0)
    if (bytes + size > maxBytes) break
    kept.push(line)
    bytes += size
  }
  return kept
}

/** 从结尾逐行累计，受行数与字节双限约束 */
const takeTail = (lines: string[], maxLines: number, maxBytes: number) => {
  const kept: string[] = []
  let bytes = 0
  for (let i = lines.length - 1; i >= 0 && kept.length < maxLines; i--) {
    const size = Buffer.byteLength(lines[i], "utf-8") + (kept.length > 0 ? 1 : 0)
    if (bytes + size > maxBytes) break
    kept.unshift(lines[i])
    bytes += size
  }
  return kept
}

/** 按方向与双限挑选保留的行；middle 额外返回头段/尾段，便于在两者之间插入省略标记 */
const selectLines = (lines: string[], maxLines: number, maxBytes: number, direction: Direction): Selection => {
  if (direction === "tail") return { kept: takeTail(lines, maxLines, maxBytes), head: [], tail: [] }
  if (direction === "middle") {
    const headLines = Math.floor(maxLines / 2)
    const headBytes = Math.floor(maxBytes / 2)
    const head = takeHead(lines, headLines, headBytes)
    const tail = takeTail(lines, maxLines - headLines, maxBytes - headBytes)
    // 文本很短导致头尾重叠（或恰好覆盖全部行）时不做中段省略，退化为按双限取前段，避免重复行
    if (head.length + tail.length >= lines.length)
      return { kept: takeHead(lines, maxLines, maxBytes), head: [], tail: [] }
    return { kept: head.concat(tail), head, tail }
  }
  return { kept: takeHead(lines, maxLines, maxBytes), head: [], tail: [] }
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const directory = path.join(global.data, DIRECTORY)
    const state = State.create<Limits, Editor>({
      name: "tool-output",
      initial: () => ({ maxLines: MAX_LINES, maxBytes: MAX_BYTES }),
      editor: (editor) => ({
        configure: (limits) => {
          if (limits.maxLines !== undefined) editor.maxLines = limits.maxLines
          if (limits.maxBytes !== undefined) editor.maxBytes = limits.maxBytes
        },
      }),
    })

    // 进程内去重缓存：内容哈希 -> 已落盘文件路径。相同输出复用既有 tool_ 文件，避免重复落盘
    const dedup = new Map<string, string>()

    const write = Effect.fnUntraced(function* (text: string) {
      const hash = createHash("sha256").update(text).digest("hex")
      const cached = dedup.get(hash)
      // 缓存中的文件可能已被 cleanup 清理，复用前先确认仍在磁盘上
      if (cached && (yield* fs.exists(cached).pipe(Effect.orElseSucceed(() => false)))) return cached
      const file = path.join(directory, fileName())
      yield* fs.ensureDir(directory).pipe(Effect.orDie)
      yield* fs.writeFileString(file, text).pipe(Effect.orDie)
      dedup.set(hash, file)
      return file
    })

    const truncate = Effect.fnUntraced(function* (result: Result, options?: TruncateOptions) {
      if (result.metadata?.truncated !== undefined) return result
      const content = result.content
      const text = content.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("\n")
      const limits = state.get()
      // 优先级：显式 options > 按工具 id 的策略表 > 全局 limits
      const strategy = (options?.toolID && TRUNCATION_STRATEGIES[options.toolID]) || DEFAULT_TRUNCATION_STRATEGY
      const maxLines = options?.maxLines ?? strategy.maxLines ?? limits.maxLines
      const maxBytes = options?.maxBytes ?? strategy.maxBytes ?? limits.maxBytes
      const direction = options?.direction ?? strategy.direction ?? "head"
      const lines = text.split("\n")
      if (text.endsWith("\n")) lines.pop()
      const totalBytes = Buffer.byteLength(text, "utf-8")
      if (lines.length <= maxLines && totalBytes <= maxBytes)
        return { ...result, metadata: { ...result.metadata, truncated: false } }

      const { kept, head, tail } = selectLines(lines, maxLines, maxBytes, direction)
      const file = yield* write(text)
      const shown =
        kept.length === 0
          ? "0 lines"
          : head.length > 0 && tail.length > 0
            ? `lines 1-${head.length} and ${lines.length - tail.length + 1}-${lines.length}`
            : direction === "tail"
              ? `lines ${lines.length - kept.length + 1}-${lines.length}`
              : `lines 1-${kept.length}`
      const marker = `[showing ${shown} of ${lines.length}; full output saved to ${file}]`
      const bounded: Tool.Content[] = []
      if (direction === "head") {
        // 既有路径：按字符预算从头裁剪，file 项保持原始位置
        let remaining = kept.join("\n").length
        let seenText = false
        let marked = false
        for (const item of content) {
          if (item.type === "file") {
            bounded.push(item)
            continue
          }
          if (seenText && remaining > 0) remaining--
          seenText = true
          if (remaining >= item.text.length) {
            bounded.push(item)
            remaining -= item.text.length
            continue
          }
          if (remaining > 0) bounded.push({ ...item, text: item.text.slice(0, remaining) })
          if (!marked) bounded.push({ type: "text", text: marker })
          remaining = 0
          marked = true
        }
        if (!marked) bounded.push({ type: "text", text: marker })
      } else {
        // tail / middle：保留的不是整段前缀，改为输出"预览 + 标记"，file 项保持原始位置
        const omitted = `[...${lines.length - head.length - tail.length} lines omitted...]`
        const preview =
          head.length > 0 && tail.length > 0
            ? `${head.join("\n")}\n${omitted}\n${tail.join("\n")}`
            : kept.join("\n")
        const texts: Tool.Content[] = []
        if (preview) texts.push({ type: "text", text: preview })
        texts.push({ type: "text", text: marker })
        let placed = false
        for (const item of content) {
          if (item.type === "file") {
            bounded.push(item)
            continue
          }
          if (placed) continue
          placed = true
          bounded.push(...texts)
        }
        if (!placed) bounded.push(...texts)
      }
      return {
        ...result,
        content: bounded,
        metadata: { ...result.metadata, truncated: true, outputPath: file },
      }
    })

    return Service.of({
      transform: state.transform,
      reload: state.reload,
      truncate,
      cleanup: () => cleanup(fs, directory),
    })
  }),
)

const cleanupLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    yield* cleanup(fs, path.join(global.data, DIRECTORY)).pipe(
      Effect.repeat(Schedule.spaced(Duration.hours(1))),
      Effect.forkScoped,
    )
  }),
)

const cleanupNode = makeGlobalNode({
  name: "tool-output-cleanup",
  layer: cleanupLayer,
  deps: [FSUtil.node, Global.node],
})

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [FSUtil.node, Global.node, cleanupNode],
})
