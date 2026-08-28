import path from "path"
import { describe, expect } from "bun:test"
import { ConfigSourceWatch } from "@opencode-ai/core/config/source-watch"
import { Watcher } from "@opencode-ai/core/filesystem/watcher"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Directory, Document, Info } from "@opencode-ai/schema/config"
import { Deferred, Effect, Fiber, Layer, Stream } from "effect"
import { it } from "../lib/effect"

describe("ConfigSourceWatch", () => {
  it.effect("shares root watches, retains unchanged roots, and releases removed roots and the plugin scope", () => {
    const counts = { starts: 0, stops: 0 }
    const native = Watcher.Native.of({
      subscribe: (input) =>
        Effect.sync(() => {
          expect(input.type).toBe("directory")
          expect(input.ignore).toEqual(["**/{node_modules,.git}/**", ".git", "node_modules"])
          counts.starts++
          return {
            unsubscribe: () => {
              counts.stops++
              return Promise.resolve()
            },
          }
        }),
    })
    return Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const root = directory("source")
        const agents = yield* ConfigSourceWatch.make(["agents"])
        const commands = yield* ConfigSourceWatch.make(["commands"])
        yield* agents.reconcile([root])
        yield* commands.reconcile([root, root, new Document({ type: "document", info: new Info({}) })])
        yield* Effect.yieldNow
        expect(counts).toEqual({ starts: 1, stops: 0 })

        yield* agents.reconcile([root])
        yield* Effect.yieldNow
        expect(counts).toEqual({ starts: 1, stops: 0 })
        yield* agents.reconcile([])
        expect(counts.stops).toBe(0)
        yield* commands.reconcile([])
        expect(counts.stops).toBe(1)

        yield* agents.reconcile([root])
        yield* Effect.yieldNow
        expect(counts).toEqual({ starts: 2, stops: 1 })
      }).pipe(Effect.scoped)
      expect(counts).toEqual({ starts: 2, stops: 2 })
    }).pipe(withNative(native))
  })

  it.effect("scope shutdown interrupts pending native watch acquisition", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const stopped = yield* Deferred.make<void>()
      const native = Watcher.Native.of({
        subscribe: () =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() => Deferred.succeed(stopped, undefined)),
          ),
      })
      yield* Effect.gen(function* () {
        const plugin = yield* Effect.gen(function* () {
          const sources = yield* ConfigSourceWatch.make(["agents"])
          yield* sources.reconcile([directory("pending")])
          yield* Effect.never
        }).pipe(Effect.scoped, Effect.forkScoped({ startImmediately: true }))
        yield* Deferred.await(started)
        yield* Fiber.interrupt(plugin)
        expect(yield* Deferred.isDone(stopped)).toBe(true)
      }).pipe(withNative(native))
    }),
  )

  it.live("disabled watching does not prevent source reconciliation", () =>
    Effect.gen(function* () {
      const sources = yield* ConfigSourceWatch.make(["agents"])
      yield* sources.reconcile([directory("disabled")])
      yield* sources.reconcile([])
      expect(yield* sources.changes.pipe(Stream.runHead, Effect.timeoutOption("1 millis"))).toMatchObject({
        _tag: "None",
      })
    }).pipe(Effect.provide(Watcher.layer({ enabled: false }).pipe(Layer.provide(Watcher.nativeLayer)))),
  )
})

function withNative(native: Watcher.NativeInterface) {
  return Effect.provide(Watcher.layer().pipe(Layer.provide(Layer.succeed(Watcher.Native, native))))
}

function directory(name: string) {
  return new Directory({ type: "directory", path: AbsolutePath.make(path.resolve(name)) })
}
