import { expect } from "bun:test"
import { Effect, Fiber, Stream } from "effect"
import { Bus } from "@opencode-ai/core/bus"
import { Catalog } from "@opencode-ai/core/catalog"
import { Credential } from "@opencode-ai/core/credential"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Integration } from "@opencode-ai/core/integration"
import { Location } from "@opencode-ai/core/location"
import { LocationServiceMap } from "@opencode-ai/core/location-services"
import { Model } from "@opencode-ai/core/model"
import { PluginSupervisor } from "@opencode-ai/core/plugin/supervisor"
import { Provider } from "@opencode-ai/core/provider"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Session } from "@opencode-ai/core/session"
import { SessionContext } from "@opencode-ai/core/session/context"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { Global } from "@opencode-ai/util/global"
import { LayerNode } from "@opencode-ai/util/effect/layer-node"
import { tempGlobalLayer } from "./fixture/global"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Bus.node, Credential.node, Session.node, LocationServiceMap.node]), [
    [Global.node, tempGlobalLayer],
  ]),
)

it.live(
  "refetches a missing Console model after an initial inventory outage",
  () =>
    Effect.gen(function* () {
      const directory = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
      )
      const location = Location.Ref.make({ directory: AbsolutePath.make(directory.path) })
      const inventory = { online: false, requests: 0 }
      const server = yield* Effect.acquireRelease(
        Effect.sync(() =>
          Bun.serve({
            port: 0,
            fetch: (request) => {
              inventory.requests++
              if (!inventory.online) return new Response("Unavailable", { status: 503 })
              return Response.json({
                config: {
                  provider: {
                    "example-console": {
                      npm: "@ai-sdk/openai",
                      api: `${new URL(request.url).origin}/v1`,
                      models: { "example-chat": { name: "Example Chat", variants: { swift: {} } } },
                    },
                  },
                },
              })
            },
          }),
        ),
        (server) => Effect.promise(() => server.stop(true)),
      )
      const credentials = yield* Credential.Service
      yield* credentials.create({
        integrationID: Integration.ID.make("opencode"),
        value: Credential.Key.make({ type: "key", key: "fixture-key", metadata: { server: server.url.origin } }),
      })
      const locations = yield* LocationServiceMap.Service
      const catalog = yield* Effect.gen(function* () {
        const plugins = yield* PluginSupervisor.Service
        yield* plugins.flush
        return yield* Catalog.Service
      }).pipe(Effect.provide(locations.get(location)))
      const model = Model.Ref.make({
        providerID: Provider.ID.make("example-console"),
        id: Model.ID.make("example-chat"),
        variant: Model.VariantID.make("swift"),
      })
      expect(yield* catalog.model.get(model.providerID, model.id)).toBeUndefined()
      inventory.online = true
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ location, model })
      const resolved = yield* Effect.gen(function* () {
        const context = yield* SessionContext.Service
        return yield* context.resolveModel(session)
      }).pipe(Effect.provide(locations.get(location)))
      expect(resolved.ref).toEqual(model)
      expect((yield* catalog.model.get(model.providerID, model.id))?.name).toBe("Example Chat")
      expect(inventory.requests).toBeGreaterThan(1)
    }),
  { timeout: 15_000 },
)

it.live(
  "keeps a Console model available after moving into a cached Location",
  () =>
    Effect.gen(function* () {
      const directories = yield* Effect.acquireRelease(
        Effect.promise(() => Promise.all([tmpdir(), tmpdir()] as const)),
        (dirs) => Effect.promise(() => Promise.all(dirs.map((dir) => dir[Symbol.asyncDispose]()))),
      )
      const destination = Location.Ref.make({ directory: AbsolutePath.make(directories[0].path) })
      const source = Location.Ref.make({ directory: AbsolutePath.make(directories[1].path) })
      const inventory = { published: false, name: "Example Chat", requests: 0 }
      const requested = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const server = yield* Effect.acquireRelease(
        Effect.sync(() =>
          Bun.serve({
            port: 0,
            fetch: async (request) => {
              inventory.requests++
              if (inventory.requests === 3) {
                requested.resolve()
                await release.promise
              }
              return Response.json({
                config: {
                  provider: {
                    "example-console": {
                      npm: "@ai-sdk/openai",
                      api: `${new URL(request.url).origin}/v1`,
                      models: inventory.published
                        ? { "example-chat": { name: inventory.name, variants: { swift: {} } } }
                        : {},
                    },
                  },
                },
              })
            },
          }),
        ),
        (server) => Effect.promise(() => server.stop(true)),
      )
      yield* Effect.addFinalizer(() => Effect.sync(() => release.resolve()))
      const credentials = yield* Credential.Service
      yield* credentials.create({
        integrationID: Integration.ID.make("opencode"),
        value: Credential.Key.make({ type: "key", key: "fixture-key", metadata: { server: server.url.origin } }),
      })
      const locations = yield* LocationServiceMap.Service
      const ready = Effect.gen(function* () {
        const plugins = yield* PluginSupervisor.Service
        yield* plugins.flush
        return yield* Catalog.Service
      })
      const cached = yield* ready.pipe(Effect.provide(locations.get(destination)))
      expect(inventory.requests).toBe(1)
      inventory.published = true
      yield* ready.pipe(Effect.provide(locations.get(source)))
      expect(inventory.requests).toBe(2)

      const session = yield* Session.Service
      const model = Model.Ref.make({
        providerID: Provider.ID.make("example-console"),
        id: Model.ID.make("example-chat"),
        variant: Model.VariantID.make("swift"),
      })
      const created = yield* session.create({
        location: source,
        model,
      })
      const resolve = Effect.gen(function* () {
        const current = yield* session.get(created.id)
        return yield* Effect.gen(function* () {
          const plugins = yield* PluginSupervisor.Service
          yield* plugins.flush
          const context = yield* SessionContext.Service
          return yield* context.resolveModel(current)
        }).pipe(Effect.provide(locations.get(current.location)))
      })
      expect((yield* resolve).ref).toEqual(model)
      const bus = yield* Bus.Service
      const updated = yield* bus.subscribe(Catalog.Event.Updated).pipe(
        Stream.filter((event) => event.location?.directory === destination.directory),
        Stream.take(1),
        Stream.mapEffect((event) => cached.model.available().pipe(Effect.map((models) => ({ event, models })))),
        Stream.runCollect,
        Effect.forkScoped({ startImmediately: true }),
      )
      yield* session.move({ sessionID: created.id, directory: destination.directory })
      yield* session.resume(created.id)
      expect((yield* session.get(created.id)).location).toEqual(destination)
      // The idle move starts the fetch; a lookup during that fetch must wait for replay, not reject the old snapshot.
      yield* Effect.promise(() => requested.promise).pipe(Effect.timeout("2 seconds"))
      const continuation = yield* resolve.pipe(Effect.forkScoped({ startImmediately: true }))
      yield* Effect.yieldNow
      expect(continuation.pollUnsafe()).toBeUndefined()
      release.resolve()
      const updates = yield* Fiber.join(updated).pipe(Effect.timeout("2 seconds"))
      expect(updates[0]?.event.location).toEqual(destination)
      expect(updates[0]?.models.map((item) => item.id)).toContain(model.id)
      expect((yield* Fiber.join(continuation)).ref).toEqual(model)
      expect(yield* ready.pipe(Effect.provide(locations.get(destination)))).toBe(cached)
      expect(inventory.requests).toBe(4)

      yield* cached.transform((draft) =>
        draft.model.update(model.providerID, model.id, (item) => {
          item.enabled = false
        }),
      )
      inventory.name = "Updated Example Chat"
      expect(yield* resolve.pipe(Effect.flip)).toBeInstanceOf(SessionRunnerModel.ModelUnavailableError)
      expect((yield* cached.model.get(model.providerID, model.id))?.name).toBe(inventory.name)
      expect(inventory.requests).toBe(5)
    }),
  { timeout: 15_000 },
)
