import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Context, Deferred, Effect, Exit, Layer, Scope } from "effect"
import type { Plugin } from "@opencode-ai/plugin/effect"
import { Global } from "@opencode-ai/util/global"
import { makeLocationNode } from "@opencode-ai/util/effect/app-node"
import { Application } from "@opencode-ai/core/application"
import { Database } from "@opencode-ai/core/database/database"
import { Location } from "@opencode-ai/core/location"
import { LocationServiceMap } from "@opencode-ai/core/location-service-map"
import { PluginRuntime } from "@opencode-ai/core/plugin/runtime"
import { PluginSupervisor } from "@opencode-ai/core/plugin/supervisor"
import { SdkPlugins } from "@opencode-ai/core/plugin/sdk"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Session } from "@opencode-ai/core/session"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { Tool } from "@opencode-ai/core/tool"
import { tempGlobalLayer } from "./fixture/global"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(Layer.empty)
const options = {
  database: { path: ":memory:" },
  config: { project: false, content: JSON.stringify({ plugins: ["-opencode.*"] }) },
  models: { fetch: false },
  fs: { filewatcher: false, fff: false },
} satisfies Application.Options

describe("Application", () => {
  it.live("shares the application's database across isolated Locations", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (directory) => Effect.promise(() => directory[Symbol.asyncDispose]()),
      )
      yield* Effect.promise(() => fs.mkdir(path.join(directory.path, "second")))
      const observed: Database.Service["Service"][] = []
      const supervisor = makeLocationNode({
        service: PluginSupervisor.Service,
        layer: Layer.effect(
          PluginSupervisor.Service,
          Effect.gen(function* () {
            const database = yield* Database.Service
            observed.push(database)
            return PluginSupervisor.Service.of({ flush: Effect.void })
          }),
        ),
        deps: [Database.node],
      })
      const context = yield* Layer.build(
        Application.layer(options, [
          [Global.node, tempGlobalLayer],
          [PluginSupervisor.node, supervisor],
        ]),
      )
      const locations = Context.get(context, LocationServiceMap.Service)
      const firstRef = Location.Ref.make({ directory: AbsolutePath.make(directory.path) })
      const first = yield* locations.contextEffect(firstRef)
      const again = yield* locations.contextEffect(firstRef)
      const second = yield* locations.contextEffect(
        Location.Ref.make({ directory: AbsolutePath.make(path.join(directory.path, "second")) }),
      )

      expect(observed).toHaveLength(2)
      expect(observed.every((database) => database === Context.get(context, Database.Service))).toBe(true)
      expect(Context.get(first, Tool.Service)).toBe(Context.get(again, Tool.Service))
      expect(Context.get(first, Tool.Service)).not.toBe(Context.get(second, Tool.Service))
    }),
  )

  it.live("isolates repeated application builds and binds plugins to their owning sessions", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (directory) => Effect.promise(() => directory[Symbol.asyncDispose]()),
      )
      const scope = yield* Effect.scope
      const firstScope = yield* Scope.fork(scope)
      const secondScope = yield* Scope.fork(scope)
      const application = Application.layer(options, [[Global.node, tempGlobalLayer]])
      const first = yield* Layer.build(application).pipe(Scope.provide(firstScope))
      const second = yield* Layer.build(application).pipe(Scope.provide(secondScope))
      const ref = Location.Ref.make({ directory: AbsolutePath.make(directory.path) })
      const firstReady = yield* Deferred.make<Plugin.Context>()
      const secondReady = yield* Deferred.make<Plugin.Context>()
      yield* Context.get(first, SdkPlugins.Service).register({
        id: "application-probe",
        effect: (context) => Deferred.succeed(firstReady, context),
      })
      yield* Context.get(second, SdkPlugins.Service).register({
        id: "application-probe",
        effect: (context) => Deferred.succeed(secondReady, context),
      })
      yield* Context.get(first, LocationServiceMap.Service).contextEffect(ref).pipe(Scope.provide(firstScope))
      yield* Context.get(second, LocationServiceMap.Service).contextEffect(ref).pipe(Scope.provide(secondScope))
      const firstPlugin = yield* Deferred.await(firstReady).pipe(Effect.timeout("5 seconds"))
      const secondPlugin = yield* Deferred.await(secondReady).pipe(Effect.timeout("5 seconds"))
      const firstSession = yield* firstPlugin.session.create({ title: "first application" })
      const secondSession = yield* secondPlugin.session.create({ title: "second application" })

      expect(Context.get(first, Database.Service)).not.toBe(Context.get(second, Database.Service))
      expect((yield* Context.get(first, Session.Service).get(firstSession.id)).title).toBe("first application")
      expect(Exit.isFailure(yield* Context.get(second, Session.Service).get(firstSession.id).pipe(Effect.exit))).toBe(
        true,
      )
      yield* Scope.close(firstScope, Exit.void)
      expect((yield* secondPlugin.session.get({ sessionID: secondSession.id })).title).toBe("second application")
      expect((yield* secondPlugin.session.create({ title: "still running" })).title).toBe("still running")
    }),
  )

  it.live("preserves interruption options through the application-owned plugin bridge", () =>
    Effect.gen(function* () {
      const seen: { sessionID: Session.ID; options?: { readonly continue?: boolean } }[] = []
      const context = yield* Layer.build(
        Application.build(PluginRuntime.node, [
          [Global.node, tempGlobalLayer],
          [Database.node, Database.configured({ path: ":memory:" })],
          [
            SessionExecution.node,
            Layer.succeed(
              SessionExecution.Service,
              SessionExecution.Service.of({
                active: Effect.succeed(new Set()),
                resume: () => Effect.void,
                wake: () => Effect.void,
                awaitIdle: () => Effect.void,
                interrupt: (sessionID, options) =>
                  Effect.sync(() => {
                    seen.push({ sessionID, options })
                    return true
                  }),
              }),
            ),
          ],
        ]),
      )
      const runtime = Context.get(context, PluginRuntime.Service)
      const sessionID = Session.ID.create()
      expect(yield* runtime.session.interrupt(sessionID, { continue: true })).toBe(true)
      expect(seen).toEqual([{ sessionID, options: { continue: true } }])
    }),
  )
})
