import { expect } from "bun:test"
import { Context, Deferred, Effect, Fiber, Latch, Layer } from "effect"
import { define } from "@opencode-ai/plugin/effect/plugin"
import { Bus } from "@opencode-ai/core/bus"
import { ConfigPluginSource } from "@opencode-ai/core/config/plugin/source"
import { Generate } from "@opencode-ai/core/generate"
import { PluginExecution } from "@opencode-ai/core/plugin/execution"
import { SdkPlugins } from "@opencode-ai/core/plugin/sdk"
import { WebSearch } from "@opencode-ai/core/websearch"
import { makeGlobalNode, makeLocationNode } from "@opencode-ai/util/effect/app-node"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { ServerFetch } from "../src/fetch"

for (const endpoint of ["websearch", "generate"]) {
  it.live(`${endpoint} HTTP execution retains plugin resources through completion`, () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-plugin-execution-")))
      const sdkReady = yield* Deferred.make<SdkPlugins.Interface>()
      const queryStarted = yield* Latch.make()
      const finishQuery = yield* Latch.make()
      const activationRequested = yield* Latch.make()
      const admissionRequested = yield* Latch.make()
      const activationStarted = yield* Latch.make()
      const finishActivation = yield* Latch.make()
      const events: string[] = []
      const definition = (version: number) =>
        define({
          id: "executor-resource",
          effect: (ctx) =>
            Effect.gen(function* () {
              const resource = { closed: false }
              yield* Effect.addFinalizer(() =>
                Effect.sync(() => {
                  resource.closed = true
                  events.push(`closed:${version}`)
                }),
              )
              if (version === 2) {
                yield* activationStarted.open
                yield* finishActivation.await
              }
              yield* ctx.websearch.transform((draft) =>
                draft.add({
                  id: "leased-provider",
                  name: "Leased provider",
                  execute: () =>
                    Effect.gen(function* () {
                      if (version === 1) {
                        yield* queryStarted.open
                        yield* finishQuery.await
                      }
                      expect(resource.closed).toBe(false)
                      events.push(`query:${version}`)
                      return []
                    }),
                }),
              )
            }),
        })
      const sdkNode = makeGlobalNode({
        service: SdkPlugins.Service,
        layer: SdkPlugins.layer.pipe(
          Layer.tap((context) => {
            const sdk = Context.get(context, SdkPlugins.Service)
            return Deferred.succeed(sdkReady, sdk).pipe(Effect.andThen(sdk.register(definition(1))))
          }),
        ),
        deps: [Bus.node],
      })
      const executionNode = makeLocationNode({
        service: PluginExecution.Service,
        layer: Layer.effect(
          PluginExecution.Service,
          Effect.gen(function* () {
            const gate = yield* PluginExecution.Service
            return PluginExecution.Service.of({
              lease: (session, effect) => admissionRequested.open.pipe(Effect.andThen(gate.lease(session, effect))),
              exclusive: (effect) => activationRequested.open.pipe(Effect.andThen(gate.exclusive(effect))),
            })
          }),
        ).pipe(Layer.provide(PluginExecution.layer)),
        deps: [],
      })
      // The Generate handler executes a real plugin provider without contacting an LLM.
      const generateNode = makeLocationNode({
        service: Generate.Service,
        layer: Layer.effect(
          Generate.Service,
          Effect.gen(function* () {
            const websearch = yield* WebSearch.Service
            return Generate.Service.of({
              text: () =>
                websearch
                  .query({
                    providerID: WebSearch.ID.make("leased-provider"),
                    query: "generate",
                  })
                  .pipe(Effect.as("generated"), Effect.orDie),
            })
          }),
        ),
        deps: [WebSearch.node],
      })
      const handler = yield* ServerFetch.make(
        {
          database: { path: ":memory:" },
          config: { directory: tmp.path, project: false },
          fs: { filewatcher: false },
        },
        {
          overrides: [
            [SdkPlugins.node, sdkNode],
            [PluginExecution.node, executionNode],
            [ConfigPluginSource.node, ConfigPluginSource.empty],
            [Generate.node, generateNode],
          ],
        },
      )
      const sdk = yield* Deferred.await(sdkReady)
      const request = Effect.promise(() => {
        const url = new URL(`http://opencode.local/api/${endpoint}`)
        url.searchParams.set("location[directory]", tmp.path)
        return handler(
          new Request(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(
              endpoint === "generate" ? { prompt: "hello" } : { providerID: "leased-provider", query: "hello" },
            ),
          }),
        )
      })
      const first = yield* request.pipe(Effect.forkScoped({ startImmediately: true }))
      yield* Effect.addFinalizer(() => finishQuery.open.pipe(Effect.andThen(finishActivation.open)))
      yield* queryStarted.await
      yield* activationRequested.close
      yield* sdk.register(definition(2))
      yield* activationRequested.await
      expect(events).toEqual([])
      yield* finishQuery.open
      expect((yield* Fiber.join(first)).status).toBe(200)
      yield* activationStarted.await
      expect(events).toEqual(["query:1", "closed:1"])
      yield* admissionRequested.close
      const second = yield* request.pipe(Effect.forkScoped({ startImmediately: true }))
      yield* admissionRequested.await
      expect(events).toEqual(["query:1", "closed:1"])
      yield* finishActivation.open
      expect((yield* Fiber.join(second)).status).toBe(200)
      expect(events).toEqual(["query:1", "closed:1", "query:2"])
    }),
  )
}
