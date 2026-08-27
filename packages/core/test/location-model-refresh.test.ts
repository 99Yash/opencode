import { expect } from "bun:test"
import { Effect, Fiber, Schedule } from "effect"
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
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { Global } from "@opencode-ai/util/global"
import { LayerNode } from "@opencode-ai/util/effect/layer-node"
import { tempGlobalLayer } from "./fixture/global"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Credential.node, Session.node, LocationServiceMap.node]), [
    [Global.node, tempGlobalLayer],
  ]),
)

it.live("keeps a Console model available after moving into a cached Location", () =>
  Effect.gen(function* () {
    const directories = yield* Effect.acquireRelease(
      Effect.promise(() => Promise.all([tmpdir(), tmpdir()] as const)),
      (dirs) => Effect.promise(() => Promise.all(dirs.map((dir) => dir[Symbol.asyncDispose]()))),
    )
    const destination = Location.Ref.make({ directory: AbsolutePath.make(directories[0].path) })
    const source = Location.Ref.make({ directory: AbsolutePath.make(directories[1].path) })
    const inventory = { published: false, requests: 0 }
    const requested = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    yield* Effect.addFinalizer(() => Effect.sync(() => release.resolve()))
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
                      ? { "example-chat": { name: "Example Chat", variants: { swift: {} } } }
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
        const models = yield* SessionRunnerModel.Service
        return yield* models.resolve(current)
      }).pipe(Effect.provide(locations.get(current.location)))
    })
    expect((yield* resolve).ref).toEqual(model)
    yield* session.move({ sessionID: created.id, directory: destination.directory })
    yield* session.resume(created.id)
    expect((yield* session.get(created.id)).location).toEqual(destination)
    // The idle move starts the fetch; a lookup during that fetch must wait for replay, not reject the old snapshot.
    yield* Effect.promise(() => requested.promise).pipe(Effect.timeout("2 seconds"))
    const continuation = yield* resolve.pipe(Effect.forkScoped({ startImmediately: true }))
    yield* Effect.yieldNow
    expect(continuation.pollUnsafe()).toBeUndefined()
    release.resolve()
    const listed = yield* cached.model.available().pipe(
      Effect.repeat({
        until: (models) => models.some((item) => item.id === model.id),
        schedule: Schedule.spaced("10 millis"),
      }),
      Effect.timeout("2 seconds"),
    )
    expect(listed.map((item) => item.id)).toContain(model.id)
    expect((yield* Fiber.join(continuation)).ref).toEqual(model)
    expect(yield* ready.pipe(Effect.provide(locations.get(destination)))).toBe(cached)
    expect(inventory.requests).toBe(3)

    yield* cached.transform((draft) =>
      draft.model.update(model.providerID, model.id, (item) => {
        item.enabled = false
      }),
    )
    expect(yield* resolve.pipe(Effect.flip)).toBeInstanceOf(SessionRunnerModel.ModelUnavailableError)
    expect(inventory.requests).toBe(4)
  }),
)
