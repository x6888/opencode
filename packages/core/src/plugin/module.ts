export * as PluginModule from "./module.js"

import type { Plugin } from "@opencode/plugin/effect/plugin"
import { Host } from "@opencode/plugin/host"
import { createPluginSources } from "@opencode/plugin/source"
import { Npm } from "@opencode/util/npm"
import { Deferred, Effect, FiberSet, PubSub, Schema, Stream } from "effect"
import path from "path"
import { stat } from "node:fs/promises"
import { fileURLToPath, pathToFileURL } from "url"
import type { ConfigPluginSource } from "../config/plugin/source.js"
import type { Generation } from "../plugin.js"
import { PluginPromise } from "./promise.js"
import { Config } from "../config.js"
import { ManagedPolicy } from "../managed-policy.js"
import { Watcher } from "../filesystem/watcher.js"

export const make = Effect.fn("PluginModule.make")(function* () {
  const config = yield* Config.Service
  const managed = yield* ManagedPolicy.Service
  const watcher = yield* Watcher.Service
  const scope = yield* Effect.scope
  const runPromise = yield* FiberSet.makeRuntimePromise()
  const changes = yield* PubSub.unbounded<void>()
  const watched = new Set<string>()
  const watch = Effect.fn("PluginModule.watch")(function* (file: string) {
    if (watched.has(file)) return
    watched.add(file)
    const ready = yield* Deferred.make<void>()
    const target = yield* Effect.promise(() => watchTarget(file))
    const updates = yield* watcher.subscribe(target, Deferred.succeed(ready, undefined))
    yield* updates.pipe(
      Stream.runForEach(() => PubSub.publish(changes, undefined)),
      Effect.ensuring(Deferred.succeed(ready, undefined)),
      Effect.forkIn(scope, { startImmediately: true }),
    )
    yield* Deferred.await(ready)
  })
  const sources = yield* Effect.acquireRelease(
    Effect.sync(() => createPluginSources((file) => runPromise(watch(file)))),
    (sources) => Effect.sync(() => sources.dispose()),
  )
  return {
    load: (
      operation: Extract<ConfigPluginSource.Operation, { type: "add" }>,
      options?: { readonly install?: boolean },
    ) =>
      Effect.gen(function* () {
        const version = operation.target.lastIndexOf("@")
        const target =
          path.isAbsolute(operation.target) || version <= 0 ? operation.target : operation.target.slice(0, version)
        if (
          ManagedPolicy.decision(
            ManagedPolicy.statements(yield* config.entries(), managed.current()),
            "integration.use",
            `plugin:${target}`,
          ) === "deny"
        )
          return { blocked: true as const }
        // T5: 单个插件的加载受超时隔离约束，超时只让这一个插件失败并被跳过，
        // supervisor 的顺序循环会继续处理后面的插件，整体不会 hang。
        return yield* withLoadTimeout(load(operation, sources, options), operation.target)
      }),
    changes: () => Stream.fromPubSub(changes),
  }
})

// A missing dependency may have missing parents too. Watch the nearest existing
// ancestor recursively so creating the rest of the path can trigger recovery.
function watchTarget(file: string): Promise<Watcher.WatchInput> {
  return stat(file).then(
    (info) => ({ path: file, type: info.isDirectory() ? "directory" : "file" }),
    (cause) => {
      if (path.dirname(file) === file) throw cause
      return watchTarget(path.dirname(file))
    },
  )
}

const Module = Schema.Struct({
  default: Schema.Union([
    Schema.Struct({
      id: Schema.String,
      effect: Schema.declare<Plugin["effect"]>((input): input is Plugin["effect"] => typeof input === "function"),
    }),
    Schema.Struct({
      id: Schema.String,
      setup: Schema.declare<Parameters<typeof PluginPromise.fromPromise>[0]["setup"]>(
        (input): input is Parameters<typeof PluginPromise.fromPromise>[0]["setup"] => typeof input === "function",
      ),
    }),
  ]),
})

export class LoadError extends Schema.TaggedError<LoadError>()("PluginModule.LoadError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

// T5: 单个插件加载的超时阈值（毫秒），覆盖 npm install/resolve + 入口解析 + 动态 import 的全过程。
// 超过该时间只隔离这一个插件（记为失败并跳过），不阻塞后续插件，也不让整体流程无限等待。
// 可选覆盖：通过环境变量 OPENCODE_PLUGIN_LOAD_TIMEOUT_MS 设置（仅用运行时内置 process/Number，无新依赖）。
const PLUGIN_LOAD_TIMEOUT_MS = Number(process.env.OPENCODE_PLUGIN_LOAD_TIMEOUT_MS) || 30_000

// T5: 区分"超时"与"插件自身真实错误"的内部哨兵。只有超时分支会带上它，
// 真实错误沿 raceFirst 原样向上抛出，因此绝不会被误判成超时。
const PLUGIN_LOAD_TIMEOUT = Symbol("plugin-load-timeout")

// T5: 为单个插件的加载包裹超时隔离。
//
// 语义等价于 Promise.race([实际加载, 超时])：这里用 Effect 侧的 raceFirst（首个 exit 胜出），
// 因为 npm 安装本身是一个 Effect，没有运行时能把它原地降级成 Promise。
//
// 关键前提：底层（npm 安装、动态 import）不接受 AbortSignal，无法真正取消，
// 所以超时只意味着"不再等待这一个插件"——它按失败处理并被跳过（supervisor 会记入 failures），
// 后续插件与整体流程继续推进；底层工作仍可能在后台继续占用资源。
function withLoadTimeout<A, E, R>(effect: Effect.Effect<A, E, R>, target: string): Effect.Effect<A, E | LoadError, R> {
  const timeout = Effect.sleep(PLUGIN_LOAD_TIMEOUT_MS).pipe(
    Effect.tap(() => Effect.logWarning({ msg: "plugin load timed out", target, timeout: PLUGIN_LOAD_TIMEOUT_MS })),
    Effect.andThen(() => Effect.fail(PLUGIN_LOAD_TIMEOUT)),
  )
  return Effect.raceFirst(effect, timeout).pipe(
    Effect.mapError((error) =>
      error === PLUGIN_LOAD_TIMEOUT
        ? new LoadError({ message: `Plugin load timed out after ${PLUGIN_LOAD_TIMEOUT_MS}ms: ${target}` })
        : (error as E),
    ),
  )
}

const load = Effect.fn("PluginModule.load")(function* (
  operation: Extract<ConfigPluginSource.Operation, { type: "add" }>,
  sources: ReturnType<typeof createPluginSources>,
  options?: { readonly install?: boolean },
) {
  const local = path.isAbsolute(operation.target)
  const npm = yield* Npm.Service
  const installed = local
    ? undefined
    : options?.install === false
      ? yield* npm.resolve(operation.target)
      : yield* npm.add(operation.target)
  // Legacy auto-discovery still admits standalone server sources. Configured
  // local plugins always arrive here as directories.
  const entrypoints: Host.Entrypoints =
    local && (yield* Effect.promise(() => stat(operation.target))).isFile()
      ? { server: pathToFileURL(operation.target).href }
      : yield* Effect.sync(() => Host.resolve(installed ?? { directory: operation.target }))
  const entrypoint = entrypoints.server
  if (!local && options?.install === false && !entrypoint) return { pending: true as const }
  if (!entrypoint) return yield* new LoadError({ message: `Plugin entrypoint not found: ${operation.target}` })
  yield* Effect.log({ msg: "loading plugin", id: operation.target, entrypoint })
  const loaded = yield* Effect.promise(() =>
    local
      ? sources.read(entrypoint)
      : Host.load(entrypoint).then((module) => ({ module, version: installed?.revision })),
  )
  const value = (yield* Schema.decodeUnknownEffect(Module)(loaded.module).pipe(
    Effect.mapError(
      (cause) =>
        new LoadError({
          message: "Plugin must export a default definition with an id and an effect or setup function.",
          cause,
        }),
    ),
  )).default
  const plugin = "effect" in value ? value : PluginPromise.fromPromise(value)
  return {
    id: plugin.id,
    features: {
      ...(entrypoints.tui ? { tui: true as const } : {}),
      ...(entrypoints.rpc ? { rpc: true as const } : {}),
    },
    revision: JSON.stringify([operation, loaded.version]),
    source: path.isAbsolute(operation.target)
      ? { type: "local" as const, path: fileURLToPath(entrypoint) }
      : {
          type: "package" as const,
          target: operation.target,
          ...(installed?.version ? { version: installed.version } : {}),
        },
    effect: (host) => plugin.effect({ ...host, options: operation.options }),
  } satisfies Generation
})
