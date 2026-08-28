import { expect } from "bun:test"
import { Effect, Fiber, Latch, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { App } from "@opencode-ai/core/app"
import { Bus } from "@opencode-ai/core/bus"
import { Database } from "@opencode-ai/core/database/database"
import { KV } from "@opencode-ai/core/kv"
import { Location } from "@opencode-ai/core/location"
import { LocationServiceMap } from "@opencode-ai/core/location-services"
import { PluginExecution } from "@opencode-ai/core/plugin/execution"
import { Plugin } from "@opencode-ai/core/plugin"
import { PluginHost } from "@opencode-ai/core/plugin/host"
import { PluginPromise } from "@opencode-ai/core/plugin/promise"
import { PluginRuntime } from "@opencode-ai/core/plugin/runtime"
import { PluginSupervisor } from "@opencode-ai/core/plugin/supervisor"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Session } from "@opencode-ai/core/session"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionGenerate } from "@opencode-ai/core/session/generate"
import { SessionGenerateNode } from "@opencode-ai/core/session/generate-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Global } from "@opencode-ai/util/global"
import { LayerNode } from "@opencode-ai/util/effect/layer-node"
import { tempGlobalLayer } from "../fixture/global"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      Bus.node,
      Session.node,
      SessionProjector.node,
      LocationServiceMap.node,
      PluginRuntime.providerNode,
      PluginRuntime.node,
      KV.node,
      App.node,
    ]),
    [
      [Global.node, tempGlobalLayer],
      [Bus.node, Bus.configured({ persist: true })],
      [SessionExecution.node, SessionExecution.noopLayer],
      [
        SessionGenerateNode.node,
        Layer.succeed(
          SessionGenerate.Service,
          SessionGenerate.Service.of({
            generate: () => Effect.succeed("generated"),
          }),
        ),
      ],
    ],
  ),
)

for (const mode of ["Effect", "Promise"]) {
  it.live(`${mode} prompt hooks can await auxiliary Session generation without granting drain ownership`, () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-plugin-reentry-")))
      const locations = yield* LocationServiceMap.Service
      const sessions = yield* Session.Service
      const ref = Location.Ref.make({ directory: AbsolutePath.make(tmp.path) })
      const session = yield* sessions.create({ location: ref })
      yield* Effect.gen(function* () {
        const plugins = yield* PluginSupervisor.Service
        yield* plugins.initialized
        const gate = yield* PluginExecution.Service
        const registry = yield* Plugin.Service
        const host = yield* PluginHost.make(registry)
        const entered = yield* Latch.make()
        const proceed = yield* Latch.make()
        const events: string[] = []
        if (mode === "Effect") {
          yield* host.session.hook(
            "prompt",
            (event) =>
              Effect.gen(function* () {
                yield* entered.open
                yield* proceed.await
                events.push(
                  (yield* host.session
                    .generate({ sessionID: event.sessionID, prompt: "Generate inside admission" })
                    .pipe(Effect.orDie)).text,
                )
              }),
            undefined,
          )
        }
        if (mode === "Promise") {
          yield* PluginPromise.fromPromise({
            id: "nested-generation",
            setup: async (ctx) => {
              await ctx.session.hook("prompt", async (event) => {
                await Effect.runPromise(entered.open)
                await Effect.runPromise(proceed.await)
                events.push(
                  (await ctx.session.generate({ sessionID: event.sessionID, prompt: "Generate inside admission" }))
                    .text,
                )
              })
            },
          }).effect(host)
        }
        const preparing = yield* sessions
          .prompt({ sessionID: session.id, text: "hello", resume: false })
          .pipe(Effect.forkScoped({ startImmediately: true }))
        yield* Effect.addFinalizer(() => proceed.open)
        yield* entered.await
        const writer = yield* gate
          .exclusive(Effect.sync(() => events.push("activation")))
          .pipe(Effect.forkScoped({ startImmediately: true }))
        const drain = yield* gate
          .lease(
            { id: session.id },
            Effect.sync(() => events.push("drain")),
          )
          .pipe(Effect.forkScoped({ startImmediately: true }))
        expect(events).toEqual([])
        yield* proceed.open
        yield* Fiber.join(preparing)
        yield* Fiber.join(writer)
        yield* Fiber.join(drain)
        expect(events).toEqual(["generated", "activation", "drain"])
      }).pipe(Effect.provide(locations.get(ref)))
    }),
  )
}
