export * as ConfigInstructionPlugin from "./instruction.js"

import { define } from "@opencode/plugin/effect/plugin"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { sameDirectory } from "@opencode/util/path"
import { dirname, join } from "path"
import { Effect, Option, PubSub, Semaphore, Stream } from "effect"
import { Watcher } from "../../filesystem/watcher.js"
import { InstructionDiscovery } from "../../instruction-discovery.js"
import { Instructions } from "../../instructions/index.js"
import { Location } from "../../location.js"
import { AbsolutePath } from "../../schema.js"

// ---- 指令文件内容缓存（进程内共享，模块级） ----
// key 为已解析的绝对路径；主失效信号是文件 mtime 变化，TTL 只作兜底：
// mtime 取不到（stat 失败）或精度不足以反映改写时，陈旧内容最多滞留 TTL 这么久。
const FILE_CACHE_TTL_MS = 30_000
const fileContentCache = new Map<string, { value: string; mtime: number; expires: number }>()

type Loaded =
  | { readonly type: "available"; readonly files: InstructionDiscovery.File[] }
  | { readonly type: "unavailable" }

export const Plugin = define({
  id: "opencode.config.instruction",
  effect: Effect.fn(function* () {
    const discovery = yield* InstructionDiscovery.Service
    // Nothing this plugin watches or loads can contribute when both scopes
    // are disabled; skip the resolves, the watcher fiber, and the transform.
    if (!discovery.project && !discovery.global) return
    yield* Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const global = yield* Global.Service
      const location = yield* Location.Service
      const watcher = yield* Watcher.Service
      const changes = yield* PubSub.sliding<string>(1)
      const lock = Semaphore.makeUnsafe(1)
      const start = yield* fs.resolve(location.directory)
      const root = yield* fs.resolve(location.project.directory)
      const home = yield* fs.resolve(global.home)
      const project = discovery.project && FSUtil.contains(root, start)
      const stop = FSUtil.contains(home, start) ? home : root
      const globalFile = yield* fs.resolve(join(global.config, "AGENTS.md"))
      const loaded: { current: Loaded } = { current: { type: "available", files: [] } }

      const publish = (update: Watcher.Update) => PubSub.publish(changes, update.path).pipe(Effect.asVoid)
      // The ancestor walk can reach the global file when the location sits
      // beneath the global config dir; global: false excludes it there too.
      const candidates = [
        ...(discovery.global ? [globalFile] : []),
        ...(project
          ? ancestorDirectories(start, stop)
              .map((directory) => join(directory, "AGENTS.md"))
              .filter((file) => discovery.global || file !== globalFile)
          : []),
      ]
      for (const path of new Set(candidates)) {
        const updates = yield* watcher.subscribe({ path, type: "file" })
        yield* updates.pipe(Stream.runForEach(publish), Effect.forkScoped({ startImmediately: true }))
      }

      // stat 只取元数据，比读内容便宜得多：命中缓存时用它做主失效信号。
      const statMtime = Effect.fnUntraced(function* (path: string) {
        const info = yield* fs.stat(path).pipe(Effect.orElseSucceed(() => undefined))
        if (!info) return undefined
        return Option.getOrUndefined(info.mtime)?.getTime()
      })

      const read = Effect.fn("ConfigInstructionPlugin.read")(function* (path: string) {
        const cached = fileContentCache.get(path)
        if (cached && Date.now() < cached.expires) {
          // 命中且未过 TTL：mtime 未变说明内容仍新鲜，直接复用，跳过 readFileString
          const mtime = yield* statMtime(path)
          if (mtime !== undefined && mtime === cached.mtime)
            return new InstructionDiscovery.File({ path: AbsolutePath.make(path), content: cached.value })
          // mtime 变化（或 stat 失败）→ 视为失效，向下回源
        }
        const content = yield* fs.readFileStringSafe(path)
        if (content === undefined) {
          // 读取失败不缓存：不要把瞬时故障固化成“指令缺失”
          fileContentCache.delete(path)
          yield* Effect.logDebug("instruction file skipped", { path, reason: "unavailable" })
          return
        }
        const mtime = yield* statMtime(path)
        fileContentCache.set(path, { value: content, mtime: mtime ?? 0, expires: Date.now() + FILE_CACHE_TTL_MS })
        return new InstructionDiscovery.File({ path: AbsolutePath.make(path), content })
      })

      const globalSource = Effect.fn("ConfigInstructionPlugin.globalSource")(function* () {
        if (!discovery.global || !(yield* fs.isFile(globalFile))) return []
        const file = yield* read(globalFile)
        return file ? [file] : []
      })

      const projectSource = Effect.fn("ConfigInstructionPlugin.projectSource")(function* () {
        if (!project) return []
        const walked = yield* Effect.forEach(
          yield* fs.up({ targets: ["AGENTS.md"], start, stop, type: "file" }),
          fs.resolve,
        )
        const discovered = new Set(walked.filter((file) => discovery.global || file !== globalFile))
        const files = yield* Effect.forEach(discovered, read, { concurrency: "unbounded" })
        if (files.some((file) => file === undefined)) return Instructions.unavailable
        return files.filter((file): file is InstructionDiscovery.File => file !== undefined)
      })

      const isolate = <A, E, R>(source: string, effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("failed to load instruction source", { source, cause }).pipe(
              Effect.as(Instructions.unavailable),
            ),
          ),
        )

      const refresh = Effect.fn("ConfigInstructionPlugin.refresh")(
        function* (file?: string) {
          // 观察者点名变更的文件先行失效：mtime 有精度上限，同一刻度内的改写可能看不出变化。
          if (file) {
            const changed = yield* fs.resolve(file)
            fileContentCache.delete(changed)
          }
          const sources = yield* Effect.all({
            global: isolate("global", globalSource()),
            project: isolate("project", projectSource()),
          })
          loaded.current =
            Array.isArray(sources.global) && Array.isArray(sources.project)
              ? { type: "available", files: [...sources.global, ...sources.project] }
              : { type: "unavailable" }
          if (!file) return
          yield* Effect.logDebug("instructions rescanned", {
            file,
            instructions:
              loaded.current.type === "available" ? loaded.current.files.map((item) => item.path) : "unavailable",
          })
        },
        (effect, ..._args: [file?: string]) => lock.withPermit(effect),
      )

      // Editor saves arrive as bursts of watcher events; settle before rescanning once. Subscribe
      // before debouncing so no update slips through while the debounce starts its pull.
      const updates = yield* PubSub.subscribe(changes)
      yield* Stream.fromSubscription(updates).pipe(
        Stream.debounce("100 millis"),
        Stream.runForEach((file) => refresh(file).pipe(Effect.andThen(discovery.reload()))),
        Effect.forkScoped({ startImmediately: true }),
      )
      yield* refresh()
      yield* discovery.transform((editor) => {
        if (loaded.current.type === "unavailable") {
          editor.unavailable()
          return
        }
        for (const file of loaded.current.files) editor.add(file)
      })
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("failed to activate instruction source", { cause }).pipe(
          Effect.andThen(discovery.transform((editor) => editor.unavailable())),
          Effect.asVoid,
        ),
      ),
    )
  }),
})

// `start` keeps the client's spelling while `stop` may come from git, so a Windows drive
// letter can differ only in case (`c:\repo` vs `C:\repo`). Compare the way FSUtil.contains
// admitted `start` beneath `stop`, or the walk passes `stop` and recurses at the drive root.
function ancestorDirectories(start: string, stop: string): string[] {
  if (sameDirectory(start, stop)) return [start]
  return [start, ...ancestorDirectories(dirname(start), stop)]
}
