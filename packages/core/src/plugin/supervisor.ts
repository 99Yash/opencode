export * as PluginSupervisor from "./supervisor.js"
export { Service, type Interface } from "./supervisor-service.js"

import { Event } from "@opencode-ai/schema/config"
import { Cause, Effect, Latch, Layer, Option, Scope, Semaphore, Stream } from "effect"
import path from "path"
import { randomUUID } from "node:crypto"
import { pathToFileURL } from "node:url"
import { ConfigPluginSource } from "../config/plugin/source.js"
import { makeLocationNode } from "@opencode-ai/util/effect/app-node"
import { Bus } from "../bus.js"
import { Npm } from "@opencode-ai/util/npm"
import { Plugin } from "../plugin.js"
import { InstancePlugins } from "./instance.js"
import { PluginInternal } from "./internal.js"
import { PluginModule } from "./module.js"
import { SdkPlugins } from "./sdk.js"
import { Service } from "./supervisor-service.js"

type Cached = { readonly operation: string; readonly plugin: Plugin.Versioned; readonly error?: string }

const resolve = Effect.fn("PluginSupervisor.resolve")(function* (
  pre: readonly Plugin.Versioned[],
  post: readonly Plugin.Versioned[],
  operations: readonly ConfigPluginSource.Operation[],
  cache: Map<string, Cached>,
) {
  const matches = (selector: string, target: string) =>
    selector === "*" || (selector.endsWith(".*") ? target.startsWith(selector.slice(0, -1)) : selector === target)
  const definitions = [...pre, ...post]
  const enabled = new Set(definitions.map((plugin) => plugin.id))
  const packages = new Map<string, Plugin.Versioned>()
  const failures = new Map<string, Extract<Plugin.Info, { readonly status: "failed" }>>()
  const previousSources = new Map(cache)
  const plugins = () => [...definitions, ...packages.values()]

  for (const operation of operations) {
    if (operation.type === "remove") {
      if (operation.target === "*") failures.clear()
      plugins()
        .filter((plugin) => matches(operation.target, plugin.id))
        .forEach((plugin) => enabled.delete(plugin.id))
      continue
    }

    const matched = plugins().filter((plugin) => matches(operation.target, plugin.id))
    const selectsPlugins =
      matched.length > 0 ||
      operation.target === "*" ||
      operation.target.endsWith(".*") ||
      operation.target.startsWith("opencode.")
    if (selectsPlugins) {
      matched.forEach((plugin) => enabled.add(plugin.id))
      continue
    }

    const cached = previousSources.get(operation.target)
    const key = JSON.stringify(operation)
    const plugin =
      cached?.operation === key
        ? cached.plugin
        : yield* PluginModule.load(operation).pipe(
            Effect.flatMap((plugin) =>
              cached && plugin.id !== cached.plugin.id
                ? Effect.fail(new Error(`Plugin ID changed from ${cached.plugin.id} to ${plugin.id}`))
                : Effect.succeed(plugin),
            ),
            Effect.catchCause((cause) =>
              Effect.logWarning("failed to load plugin", { target: operation.target, cause }).pipe(
                Effect.as({ error: Plugin.errorMessage(cause) }),
              ),
            ),
          )
    if ("error" in plugin) {
      failures.set(operation.target, {
        source: pluginSource(operation.target),
        status: "failed",
        error: plugin.error,
        tui: false,
      })
      if (cached) {
        cache.set(operation.target, { ...cached, operation: key, error: plugin.error })
        packages.set(operation.target, cached.plugin)
        enabled.add(cached.plugin.id)
      }
      continue
    }
    if (cached?.operation === key && cached.error) {
      failures.set(operation.target, {
        source: pluginSource(operation.target),
        status: "failed",
        error: cached.error,
        tui: plugin.tui ?? false,
      })
    } else {
      failures.delete(operation.target)
      cache.set(operation.target, { operation: key, plugin })
    }
    const previous = packages.get(operation.target)
    if (previous) enabled.delete(previous.id)
    packages.set(operation.target, plugin)
    enabled.add(plugin.id)
  }

  return {
    plugins: [
      ...pre.filter((plugin) => enabled.has(plugin.id)),
      ...[...packages.values()].filter((plugin) => enabled.has(plugin.id)),
      ...post.filter((plugin) => enabled.has(plugin.id)),
    ],
    failures: [...failures.entries()]
      .filter(([target]) => {
        const plugin = packages.get(target)
        return !plugin || enabled.has(plugin.id)
      })
      .map(([, failure]) => failure),
  }
})

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const registry = yield* Plugin.Service
    const sdk = yield* SdkPlugins.Service
    const instance = yield* InstancePlugins.Service
    const sources = yield* ConfigPluginSource.Service
    const bus = yield* Bus.Service
    const npm = yield* Npm.Service
    const scope = yield* Scope.Scope
    const ready = yield* Latch.make()
    const initialized = yield* Latch.make()
    const mutations = yield* Semaphore.make(1)
    const cache = new Map<string, Cached>()
    // Internal definitions capture stable Location services; SDK contributions remain dynamic.
    const internal = yield* PluginInternal.list()
    let observed = 0

    const activate = Effect.fn("PluginSupervisor.activate")(function* (
      operations: readonly ConfigPluginSource.Operation[],
      previous: ReadonlyMap<string, Cached> = new Map(cache),
    ) {
      // Combine internal plugins with host-contributed plugins in boot order.
      // Instance-bound plugins come last: later activation can override earlier
      // container writes, so the instance's explicit choices win over globals.
      const pre = [
        ...internal.pre.map((plugin) => ({ ...plugin, version: "internal", source: { type: "builtin" as const } })),
        ...sdk.all(),
        ...instance.all(),
      ]
      const post = internal.post.map((plugin) => ({
        ...plugin,
        version: "internal",
        source: { type: "builtin" as const },
      }))
      // Apply config operations and load enabled package plugins into one ordered generation.
      const resolved = yield* resolve(pre, post, operations, cache).pipe(Effect.provideService(Npm.Service, npm))
      // Replace the active generation in one scoped, batched activation.
      const activated = yield* registry.activate(resolved.plugins, resolved.failures).pipe(Effect.exit)
      if (activated._tag === "Failure") {
        cache.clear()
        previous.forEach((entry, target) => cache.set(target, entry))
        return yield* Effect.failCause(activated.cause)
      }
      const inventory = yield* registry.list()
      for (const [target, entry] of cache) {
        if (!operations.some((operation) => operation.type === "add" && operation.target === target)) {
          cache.delete(target)
          continue
        }
        const active = inventory.find((item) =>
          item.source.type === "local"
            ? item.source.path === target
            : item.source.type === "package" && item.source.package === target,
        )
        if (active?.status !== "active" || !active.error) continue
        const old = previous.get(target)
        if (old) cache.set(target, { ...old, operation: entry.operation, error: active.error })
      }
      return inventory
    })

    const operation = Effect.fnUntraced(function* (target: string) {
      const operations = yield* sources.operations().pipe(Effect.provideService(Scope.Scope, scope))
      const entry = operations.findLast((entry) => entry.type === "add" && entry.target === target)
      const inventory = yield* registry.list()
      if (
        !entry ||
        entry.type !== "add" ||
        target === "*" ||
        target.endsWith(".*") ||
        target.startsWith("opencode.") ||
        (!cache.has(target) &&
          !inventory.some((item) =>
            item.source.type === "local"
              ? item.source.path === target
              : item.source.type === "package" && item.source.package === target,
          ))
      )
        return yield* new Plugin.OperationError({ message: `Not a configured plugin source: ${target}` })
      return { entry, operations }
    })

    const mutate = (target: string, action: "update" | "reload") =>
      initialized.await.pipe(
        Effect.andThen(
          mutations.withPermit(
            Effect.gen(function* () {
              const selected = yield* operation(target)
              if (action === "update") {
                if (path.isAbsolute(target) || !(yield* npm.inspect(target)).mutable)
                  return yield* new Plugin.OperationError({ message: `Plugin source cannot be updated: ${target}` })
              }
              const previous = new Map(cache)
              const generation = randomUUID()
              const staged = path.isAbsolute(target)
                ? {
                    directory: path.dirname(target),
                    generation,
                    entrypoint: `${typeof Bun !== "undefined" ? target.replaceAll("\\", "/") : pathToFileURL(target).href}?reload=${generation}`,
                  }
                : yield* action === "update"
                    ? npm.update(target, { subpaths: ["server", ""] })
                    : npm.reload(target, {
                        subpaths: ["server", ""],
                        revision: cache.get(target)?.plugin.revision,
                        generation: cache.get(target)?.plugin.generation,
                      })
              const loaded = yield* PluginModule.load(selected.entry, staged).pipe(
                Effect.provideService(Npm.Service, npm),
                Effect.exit,
              )
              if (loaded._tag === "Failure") {
                const old = cache.get(target)
                if (!old) return yield* Effect.failCause(loaded.cause)
                cache.set(target, {
                  ...old,
                  operation: JSON.stringify(selected.entry),
                  error: Plugin.errorMessage(loaded.cause),
                })
                return yield* activate(selected.operations, previous)
              }
              const old = cache.get(target)
              if (old && loaded.value.id !== old.plugin.id) {
                cache.set(target, {
                  ...old,
                  operation: JSON.stringify(selected.entry),
                  error: `Plugin ID changed from ${old.plugin.id} to ${loaded.value.id}`,
                })
                return yield* activate(selected.operations, previous)
              }
              cache.set(target, { operation: JSON.stringify(selected.entry), plugin: loaded.value })
              return yield* activate(selected.operations, previous)
            }),
          ),
        ),
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt
          const error = Option.getOrUndefined(Cause.findErrorOption(cause))
          return Effect.fail(
            error instanceof Plugin.OperationError
              ? error
              : new Plugin.OperationError({ message: `Unable to ${action} plugin source.` }),
          )
        }),
      )
    const updates = Stream.merge(sources.changes(), bus.subscribe([Event.Updated, SdkPlugins.Updated])).pipe(
      // Make accepted work visible to flush before coalescing the burst.
      Stream.mapEffect(() =>
        Effect.gen(function* () {
          observed++
          yield* ready.close
          return observed
        }),
      ),
    )
    yield* Stream.concat(Stream.succeed(0), updates).pipe(
      // Keep observing updates while activation runs, retaining only the latest generation request.
      Stream.buffer({ capacity: 1, strategy: "sliding" }),
      Stream.debounce("100 millis"),
      Stream.runForEach((target) =>
        Effect.gen(function* () {
          yield* mutations
            .withPermit(
              Effect.gen(function* () {
                return yield* activate(yield* sources.operations().pipe(Effect.provideService(Scope.Scope, scope)))
              }),
            )
            .pipe(Effect.catchCause((cause) => Effect.logError("failed to reload plugins", { cause })))
          if (observed === target) {
            yield* initialized.open
            yield* ready.open
          }
        }),
      ),
      Effect.forkScoped({ startImmediately: true }),
    )
    return Service.of({
      flush: ready.await,
      initialized: initialized.await,
      check: (target) =>
        initialized.await.pipe(
          Effect.andThen(
            mutations.withPermit(
              Effect.gen(function* () {
                yield* operation(target)
                if (path.isAbsolute(target)) return { mutable: false }
                return yield* npm.check(target)
              }),
            ),
          ),
          Effect.catchCause((cause) => {
            if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt
            const error = Option.getOrUndefined(Cause.findErrorOption(cause))
            return Effect.fail(
              error instanceof Plugin.OperationError
                ? error
                : new Plugin.OperationError({ message: "Unable to check plugin source." }),
            )
          }),
        ),
      update: (target) => mutate(target, "update"),
      reload: (target) => mutate(target, "reload"),
    })
  }),
)

const nodeDeps = [
  Plugin.node,
  SdkPlugins.node,
  InstancePlugins.node,
  ConfigPluginSource.node,
  Bus.node,
  Npm.node,
  PluginInternal.requirements,
] as const

function pluginSource(target: string): Plugin.Source {
  if (path.isAbsolute(target)) return { type: "local", path: target }
  return { type: "package", package: target }
}

export const node = makeLocationNode({ service: Service, layer, deps: nodeDeps })
