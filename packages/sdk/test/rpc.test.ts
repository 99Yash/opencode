import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { fromPromise } from "@opencode-ai/plugin/promise/adapter"
import { Rpc } from "@opencode-ai/schema/rpc"
import { Deferred, Effect, Exit, Fiber, Layer, Scope, Stream } from "effect"
import { z } from "zod"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { testEffect } from "../../core/test/lib/effect"
import { AbsolutePath, OpenCode, type OpenCodeEvent } from "../src"

const it = testEffect(Layer.empty)
export const Echo = Rpc.define({
  namespace: "sdk/echo",
  methods: {
    echo: { input: z.string(), output: z.object({ message: z.string(), directory: z.string() }) },
    empty: { input: z.undefined(), output: z.undefined() },
    fail: {
      input: z.undefined(),
      output: z.string(),
      errors: { rejected: z.object({ source: z.string() }) },
    },
  },
  events: {},
})
const Update = z.object({ message: z.string(), at: z.string() })
const Updates = Rpc.define({
  namespace: "sdk/updates",
  methods: { emit: { input: Update, output: z.undefined() } },
  events: { updated: { schema: Update } },
})
const Blocking = Rpc.define({
  namespace: "sdk/blocking",
  methods: { wait: { input: z.string(), output: z.string() } },
  events: {},
})

async function fixture() {
  const directory = await tmpdir("opencode-sdk-rpc-")
  const first = AbsolutePath.make(join(directory.path, "first project"))
  const second = AbsolutePath.make(join(directory.path, "second project"))
  const config = join(directory.path, "config")
  await Promise.all([first, second, config].map((path) => mkdir(path)))
  return {
    first,
    second,
    options: { config: { directory: config, project: false, content: "{}" }, fs: { filewatcher: false } },
    [Symbol.asyncDispose]: () => directory[Symbol.asyncDispose](),
  }
}

test("Promise SDK calls configured Promise RPC plugins on cold locations", async () => {
  await using dirs = await fixture()
  await using opencode = await OpenCode.create({
    ...dirs.options,
    plugins: [
      {
        id: "sdk-promise-echo",
        async setup(ctx) {
          const location = (await ctx.agent.list()).location
          await ctx.rpc.register(Echo, {
            echo: async (message) => ({ message, directory: location.directory }),
            empty: async () => undefined,
            fail: async (_input, ctx) => ctx.error("rejected", "plugin handler failed", { source: "return" }),
          })
        },
      },
    ],
  })
  const rpc = opencode.rpc(Echo)
  expect(await rpc.echo("first", { location: { directory: dirs.first } })).toEqual({
    message: "first",
    directory: dirs.first,
  })
  expect(await rpc.echo("header", { headers: { "x-opencode-directory": encodeURIComponent(dirs.second) } })).toEqual({
    message: "header",
    directory: dirs.second,
  })
  expect(
    await rpc.echo("explicit", {
      location: { directory: dirs.first },
      headers: { "x-opencode-directory": encodeURIComponent(dirs.second) },
    }),
  ).toEqual({ message: "explicit", directory: dirs.first })
  expect(await rpc.echo("default")).toEqual({ message: "default", directory: process.cwd() })
  expect(await rpc.empty(undefined, { location: { directory: dirs.first } })).toBeUndefined()
  expect(
    await opencode.rpc.call({
      namespace: Echo.namespace,
      method: "echo",
      input: "raw",
      location: { directory: dirs.first },
    }),
  ).toEqual({
    output: { message: "raw", directory: dirs.first },
  })
  expect(
    await rpc.fail(undefined, { location: { directory: dirs.first } }).catch((error: unknown) => error),
  ).toMatchObject({
    type: "rejected",
    message: "plugin handler failed",
    data: { source: "return" },
  })
}, 30_000)

it.live(
  "Effect SDK calls Promise plugin RPC handlers without prebooting locations",
  () =>
    Effect.gen(function* () {
      const dirs = yield* Effect.acquireRelease(Effect.promise(fixture), (dirs) =>
        Effect.promise(() => dirs[Symbol.asyncDispose]()),
      )
      const sdk = yield* Effect.promise(() => import("../src/effect"))
      const opencode = yield* sdk.OpenCode.create(dirs.options)
      yield* opencode.plugin(
        fromPromise({
          id: "sdk-cross-style-echo",
          async setup(ctx) {
            const location = (await ctx.agent.list()).location
            await ctx.rpc.register(Echo, {
              echo: async (message) => ({ message, directory: location.directory }),
              empty: async () => undefined,
              fail: async (_input, ctx) => {
                throw ctx.error("rejected", "cross-style handler failed", { source: "throw" })
              },
            })
          },
        }),
      )
      const rpc = opencode.rpc(Echo)
      expect(yield* rpc.echo("cross-style", { location: { directory: dirs.first } })).toEqual({
        message: "cross-style",
        directory: dirs.first,
      })
      expect(
        yield* rpc.echo("header", { headers: { "x-opencode-directory": encodeURIComponent(dirs.second) } }),
      ).toEqual({ message: "header", directory: dirs.second })
      expect(
        yield* rpc.echo("explicit", {
          location: { directory: dirs.first },
          headers: { "x-opencode-directory": encodeURIComponent(dirs.second) },
        }),
      ).toEqual({ message: "explicit", directory: dirs.first })
      expect(yield* rpc.echo("default")).toEqual({ message: "default", directory: process.cwd() })
      expect(yield* rpc.empty(undefined, { location: { directory: dirs.first } })).toBeUndefined()
      expect(yield* rpc.fail(undefined, { location: { directory: dirs.first } }).pipe(Effect.flip)).toMatchObject({
        type: "rejected",
        message: "cross-style handler failed",
        data: { source: "throw" },
      })
    }),
  30_000,
)

test("Promise SDK calls a config-loaded Effect plugin through the shared RPC definition", async () => {
  await using dirs = await fixture()
  const plugin = join(dirs.options.config.directory, "effect-plugin.ts")
  // The config-loaded plugin and the external caller use the exact same contract.
  await Bun.write(
    plugin,
    `
    import { Effect } from ${JSON.stringify(import.meta.resolve("effect"))}
    import { Plugin } from ${JSON.stringify(import.meta.resolve("@opencode-ai/plugin/effect"))}
    import { Echo } from ${JSON.stringify(import.meta.url)}
    export default Plugin.define({
      id: "sdk-config-effect-echo",
      effect: (ctx) => Effect.gen(function* () {
        const location = (yield* ctx.agent.list()).location
        yield* ctx.rpc.register(Echo, {
          echo: (message) => Effect.succeed({ message, directory: location.directory }),
          empty: () => Effect.succeed(undefined),
           fail: (_input, ctx) =>
             Effect.fail(ctx.error("rejected", "Effect plugin handler failed", { source: "effect" })),
        })
      }).pipe(Effect.orDie),
    })
  `,
  )
  await using opencode = await OpenCode.create({
    ...dirs.options,
    config: { ...dirs.options.config, content: JSON.stringify({ plugins: [plugin] }) },
  })
  const rpc = opencode.rpc(Echo)
  expect(await rpc.echo("Effect", { location: { directory: dirs.first } })).toEqual({
    message: "Effect",
    directory: dirs.first,
  })
  expect(await rpc.empty(undefined, { location: { directory: dirs.first } })).toBeUndefined()
  expect(
    await rpc.fail(undefined, { location: { directory: dirs.first } }).catch((error: unknown) => error),
  ).toMatchObject({
    type: "rejected",
    message: "Effect plugin handler failed",
    data: { source: "effect" },
  })
}, 30_000)

test("Promise SDK native and typed RPC subscriptions carry real plugin events across locations", async () => {
  await using dirs = await fixture()
  await using opencode = await OpenCode.create({
    ...dirs.options,
    plugins: [
      {
        id: "sdk-promise-updates",
        async setup(ctx) {
          const registration = await ctx.rpc.register(Updates, {
            emit: async (input): Promise<undefined> => {
              await registration.events.emit("updated", input)
              return undefined
            },
          })
        },
      },
    ],
  })
  expect(opencode.events).toBe(opencode.event)
  const native = opencode.events.subscribe()[Symbol.asyncIterator]()
  const rpc = opencode.rpc(Updates)
  const first = rpc.events.subscribe("updated")[Symbol.asyncIterator]()
  const second = opencode.rpc(Updates).events.subscribe("updated")[Symbol.asyncIterator]()
  const controller = new AbortController()
  const cancelled = rpc.events.subscribe("updated", { signal: controller.signal })[Symbol.asyncIterator]()
  try {
    const firstNext = first.next()
    const secondNext = second.next()
    const cancelledNext = cancelled.next()
    expect(await native.next()).toMatchObject({ done: false, value: { type: "server.connected" } })
    controller.abort()
    expect(await cancelledNext).toMatchObject({ done: true })
    const at = "2026-08-27T12:00:00.000Z"
    expect(await rpc.emit({ message: "first", at }, { location: { directory: dirs.first } })).toBeUndefined()
    const published = await nextRpcEvent(native, "rpc.sdk/updates.updated")
    const event = (await firstNext).value
    expect(published).toMatchObject({
      type: "rpc.sdk/updates.updated",
      location: { directory: dirs.first },
      data: { message: "first", at },
    })
    expect(event).toMatchObject({
      id: published.id,
      created: published.created,
      type: "rpc.sdk/updates.updated",
      location: { directory: dirs.first },
      data: { message: "first", at },
    })
    expect((await secondNext).value).toEqual(event)
    const returning = first.next()
    await first.return?.()
    expect(await returning).toMatchObject({ done: true })
    const next = second.next()
    await rpc.emit({ message: "second", at }, { location: { directory: dirs.second } })
    const other = await nextRpcEvent(native, "rpc.sdk/updates.updated")
    expect((await next).value).toMatchObject({
      id: other.id,
      type: "rpc.sdk/updates.updated",
      location: { directory: dirs.second },
      data: { message: "second", at },
    })
    expect(other).toMatchObject({ type: "rpc.sdk/updates.updated", location: { directory: dirs.second } })
  } finally {
    controller.abort()
    await Promise.all([native.return?.(), first.return?.(), second.return?.(), cancelled.return?.()])
  }
  // Reopening after the last subscriber leaves must not wait on a leaked source.
  const reopened = opencode.events.subscribe()[Symbol.asyncIterator]()
  try {
    expect(await reopened.next()).toMatchObject({ done: false, value: { type: "server.connected" } })
  } finally {
    await reopened.return?.()
  }
}, 30_000)

async function nextRpcEvent(events: AsyncIterator<OpenCodeEvent>, type: `rpc.${string}`) {
  while (true) {
    const event = await events.next()
    if (event.done) throw new Error("Event stream ended before the RPC event")
    if (event.value.type === type) return event.value
  }
}

it.live(
  "Effect SDK native and typed streams receive Effect plugin RPC events across locations",
  () =>
    Effect.gen(function* () {
      const dirs = yield* Effect.acquireRelease(Effect.promise(fixture), (dirs) =>
        Effect.promise(() => dirs[Symbol.asyncDispose]()),
      )
      const sdk = yield* Effect.promise(() => import("../src/effect"))
      const opencode = yield* sdk.OpenCode.create(dirs.options)
      yield* opencode.plugin({
        id: "sdk-effect-updates",
        effect: (ctx) =>
          Effect.gen(function* () {
            const registration = yield* ctx.rpc.register(Updates, {
              emit: (input): Effect.Effect<undefined> =>
                registration.events.emit("updated", input).pipe(Effect.as(undefined), Effect.orDie),
            })
          }).pipe(Effect.orDie),
      })
      expect(opencode.events).toBe(opencode.event)
      const connected = yield* Deferred.make<void>()
      const rpc = opencode.rpc(Updates)
      const typed = yield* rpc.events
        .subscribe("updated")
        .pipe(Stream.take(2), Stream.runCollect, Effect.forkScoped({ startImmediately: true }))
      const cancelled = yield* rpc.events
        .subscribe("updated")
        .pipe(Stream.runDrain, Effect.forkScoped({ startImmediately: true }))
      const native = yield* opencode.events.subscribe().pipe(
        Stream.tap((event) =>
          event.type === "server.connected" ? Deferred.succeed(connected, undefined) : Effect.void,
        ),
        Stream.filter((event) => event.type === "rpc.sdk/updates.updated"),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkScoped({ startImmediately: true }),
      )
      yield* Deferred.await(connected).pipe(Effect.timeout("5 seconds"))
      yield* Fiber.interrupt(cancelled)
      const at = "2026-08-27T12:00:00.000Z"
      yield* rpc.emit({ message: "first", at }, { location: { directory: dirs.first } })
      yield* rpc.emit({ message: "second", at }, { location: { directory: dirs.second } })
      const events = yield* Fiber.join(typed).pipe(Effect.timeout("5 seconds"))
      const nativeEvents = yield* Fiber.join(native).pipe(Effect.timeout("5 seconds"))
      expect(events).toHaveLength(2)
      expect(nativeEvents).toHaveLength(2)
      expect(
        events.map((event) => ({
          id: event.id,
          type: event.type,
          directory: event.location.directory,
          data: event.data,
        })),
      ).toEqual([
        {
          id: nativeEvents[0].id,
          type: "rpc.sdk/updates.updated",
          directory: dirs.first,
          data: { message: "first", at },
        },
        {
          id: nativeEvents[1].id,
          type: "rpc.sdk/updates.updated",
          directory: dirs.second,
          data: { message: "second", at },
        },
      ])
      expect(nativeEvents.map((event) => event.data)).toEqual([
        { message: "first", at },
        { message: "second", at },
      ])
      const reconnected = yield* opencode.events
        .subscribe()
        .pipe(Stream.take(1), Stream.runCollect, Effect.timeout("5 seconds"))
      expect(reconnected).toMatchObject([{ type: "server.connected" }])
    }),
  30_000,
)

test("Promise SDK stable RPC handles use the latest plugin override in every booted location", async () => {
  await using dirs = await fixture()
  await using opencode = await OpenCode.create({
    ...dirs.options,
    plugins: [
      {
        id: "sdk-original",
        async setup(ctx) {
          const location = (await ctx.agent.list()).location
          await ctx.rpc.register(Echo, {
            echo: async (input) => ({ message: `original:${input}`, directory: location.directory }),
            empty: async () => undefined,
            fail: async () => "unused",
          })
        },
      },
    ],
  })
  const rpc = opencode.rpc(Echo)
  expect(await rpc.echo("first", { location: { directory: dirs.first } })).toEqual({
    message: "original:first",
    directory: dirs.first,
  })
  expect(await rpc.echo("second", { location: { directory: dirs.second } })).toEqual({
    message: "original:second",
    directory: dirs.second,
  })
  const events = opencode.events.subscribe()[Symbol.asyncIterator]()
  try {
    expect(await events.next()).toMatchObject({ value: { type: "server.connected" } })
    for (const version of ["override", "replacement"]) {
      await opencode.plugin({
        id: "sdk-override",
        async setup(ctx) {
          const location = (await ctx.agent.list()).location
          await ctx.rpc.register(Echo, {
            echo: async (input) => ({ message: `${version}:${input}`, directory: location.directory }),
            empty: async () => undefined,
            fail: async () => "unused",
          })
        },
      })
      const pending = new Set<string>([dirs.first, dirs.second])
      while (pending.size) {
        const event = await events.next()
        if (event.done) throw new Error("Event stream ended before plugin reload completed")
        if (event.value.type === "plugin.updated" && event.value.location)
          pending.delete(event.value.location.directory)
      }
      expect(await rpc.echo("first", { location: { directory: dirs.first } })).toEqual({
        message: `${version}:first`,
        directory: dirs.first,
      })
      expect(await rpc.echo("second", { location: { directory: dirs.second } })).toEqual({
        message: `${version}:second`,
        directory: dirs.second,
      })
    }
  } finally {
    await events.return?.()
  }
}, 30_000)

test("Promise SDK cancellation reaches the actual RPC handler without cancelling other calls", async () => {
  await using dirs = await fixture()
  const started = Promise.withResolvers<void>()
  const stopped = Promise.withResolvers<AbortSignal>()
  await using opencode = await OpenCode.create({
    ...dirs.options,
    plugins: [
      {
        id: "sdk-promise-blocking",
        async setup(ctx) {
          await ctx.rpc.register(Blocking, {
            wait: async (input, call) => {
              if (input === "complete") return input
              started.resolve()
              await new Promise<void>((resolve) =>
                call.signal.addEventListener(
                  "abort",
                  () => {
                    stopped.resolve(call.signal)
                    resolve()
                  },
                  { once: true },
                ),
              )
              return input
            },
          })
        },
      },
    ],
  })
  const rpc = opencode.rpc(Blocking)
  const controller = new AbortController()
  const pending = rpc
    .wait("cancel", { location: { directory: dirs.first }, signal: controller.signal })
    .catch((error: unknown) => error)
  try {
    await Effect.promise(() => started.promise).pipe(Effect.timeout("5 seconds"), Effect.runPromise)
    expect(await rpc.wait("complete", { location: { directory: dirs.first } })).toBe("complete")
    controller.abort()
    expect(await pending).toMatchObject({ name: "ClientError", reason: "Transport" })
    expect(
      (await Effect.promise(() => stopped.promise).pipe(Effect.timeout("5 seconds"), Effect.runPromise)).aborted,
    ).toBe(true)
    expect(await rpc.wait("complete", { location: { directory: dirs.first } })).toBe("complete")
  } finally {
    controller.abort()
    await pending
  }
}, 30_000)

it.live(
  "Effect SDK interruption finalizes Effect RPC handlers and keeps independent calls usable",
  () =>
    Effect.gen(function* () {
      const dirs = yield* Effect.acquireRelease(Effect.promise(fixture), (dirs) =>
        Effect.promise(() => dirs[Symbol.asyncDispose]()),
      )
      const sdk = yield* Effect.promise(() => import("../src/effect"))
      const opencode = yield* sdk.OpenCode.create(dirs.options)
      const started = yield* Deferred.make<void>()
      const stopped = yield* Deferred.make<void>()
      yield* opencode.plugin({
        id: "sdk-effect-blocking",
        effect: (ctx) =>
          ctx.rpc
            .register(Blocking, {
              wait: (input) =>
                input === "complete"
                  ? Effect.succeed(input)
                  : Deferred.succeed(started, undefined).pipe(
                      Effect.andThen(Effect.never),
                      Effect.ensuring(Deferred.succeed(stopped, undefined)),
                    ),
            })
            .pipe(Effect.asVoid, Effect.orDie),
      })
      const rpc = opencode.rpc(Blocking)
      const pending = yield* rpc.wait("cancel", { location: { directory: dirs.first } }).pipe(Effect.forkScoped)
      yield* Deferred.await(started).pipe(Effect.timeout("5 seconds"))
      expect(yield* rpc.wait("complete", { location: { directory: dirs.first } })).toBe("complete")
      yield* Fiber.interrupt(pending)
      yield* Deferred.await(stopped).pipe(Effect.timeout("5 seconds"))
      expect(yield* rpc.wait("complete", { location: { directory: dirs.first } })).toBe("complete")
    }),
  30_000,
)

test("Promise SDK close cancels active native and typed RPC subscriptions and releases the plugin", async () => {
  await using dirs = await fixture()
  const released = Promise.withResolvers<void>()
  await using opencode = await OpenCode.create({
    ...dirs.options,
    plugins: [
      {
        id: "sdk-close-updates",
        async setup(ctx) {
          const registration = await ctx.rpc.register(Updates, {
            emit: async (input): Promise<undefined> => {
              await registration.events.emit("updated", input)
              return undefined
            },
          })
          return () => released.resolve()
        },
      },
    ],
  })
  const rpc = opencode.rpc(Updates)
  const typed = rpc.events.subscribe("updated")[Symbol.asyncIterator]()
  const native = opencode.events.subscribe()[Symbol.asyncIterator]()
  try {
    const first = typed.next()
    expect(await native.next()).toMatchObject({ value: { type: "server.connected" } })
    await rpc.emit({ message: "ready", at: "2026-08-27T12:00:00.000Z" }, { location: { directory: dirs.first } })
    expect((await first).value).toMatchObject({ type: "rpc.sdk/updates.updated" })
    await nextRpcEvent(native, "rpc.sdk/updates.updated")
    const typedPending = typed.next().catch((error: unknown) => error)
    const nativePending = native.next().catch((error: unknown) => error)
    await opencode.close()
    expect(await typedPending).toMatchObject({ name: "ClientError", reason: "Transport" })
    expect(await nativePending).toMatchObject({ name: "ClientError", reason: "Transport" })
    await released.promise
    await opencode.close()
  } finally {
    await Promise.all([native.return?.(), typed.return?.()])
  }
}, 30_000)

it.live(
  "closing the Effect SDK scope stops active native and typed RPC subscriptions",
  () =>
    Effect.gen(function* () {
      const dirs = yield* Effect.acquireRelease(Effect.promise(fixture), (dirs) =>
        Effect.promise(() => dirs[Symbol.asyncDispose]()),
      )
      const sdk = yield* Effect.promise(() => import("../src/effect"))
      const hostScope = yield* Effect.acquireRelease(Scope.make(), (scope) => Scope.close(scope, Exit.void))
      const opencode = yield* sdk.OpenCode.create(dirs.options).pipe(Effect.provideService(Scope.Scope, hostScope))
      const connected = yield* Deferred.make<void>()
      const received = yield* Deferred.make<void>()
      const released = yield* Deferred.make<void>()
      yield* opencode.plugin({
        id: "sdk-effect-close-updates",
        effect: (ctx) =>
          Effect.gen(function* () {
            const registration = yield* ctx.rpc.register(Updates, {
              emit: (input): Effect.Effect<undefined> =>
                registration.events.emit("updated", input).pipe(Effect.as(undefined), Effect.orDie),
            })
            yield* Effect.addFinalizer(() => Deferred.succeed(released, undefined).pipe(Effect.asVoid))
          }).pipe(Effect.orDie),
      })
      const rpc = opencode.rpc(Updates)
      const typed = yield* rpc.events.subscribe("updated").pipe(
        Stream.runForEach(() => Deferred.succeed(received, undefined)),
        Effect.forkScoped({ startImmediately: true }),
      )
      const native = yield* opencode.events.subscribe().pipe(
        Stream.runForEach((event) =>
          event.type === "server.connected" ? Deferred.succeed(connected, undefined) : Effect.void,
        ),
        Effect.forkScoped({ startImmediately: true }),
      )
      yield* Deferred.await(connected).pipe(Effect.timeout("5 seconds"))
      yield* rpc.emit({ message: "ready", at: "2026-08-27T12:00:00.000Z" }, { location: { directory: dirs.first } })
      yield* Deferred.await(received).pipe(Effect.timeout("5 seconds"))
      yield* Scope.close(hostScope, Exit.void).pipe(Effect.timeout("5 seconds"))
      expect(Exit.isFailure(yield* Fiber.await(typed).pipe(Effect.timeout("5 seconds")))).toBe(true)
      expect(Exit.isFailure(yield* Fiber.await(native).pipe(Effect.timeout("5 seconds")))).toBe(true)
      yield* Deferred.await(released).pipe(Effect.timeout("5 seconds"))
    }),
  30_000,
)
