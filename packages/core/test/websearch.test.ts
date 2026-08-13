import { describe, expect } from "bun:test"
import { Effect, Exit, Random, Scope } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/util/effect/layer-node"
import { Bus } from "@opencode-ai/core/bus"
import { KV } from "@opencode-ai/core/kv"
import { WebSearch } from "@opencode-ai/core/websearch"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([WebSearch.node, Bus.node, KV.node])))

const register = (id: string, behavior: "results" | "empty" | "fail" = "results") =>
  Effect.gen(function* () {
    const websearch = yield* WebSearch.Service
    const providerID = WebSearch.ID.make(id)
    const calls: WebSearch.ProviderInput[] = []
    yield* websearch.transform((draft) => {
      draft.add({
        id: providerID,
        name: id.toUpperCase(),
        execute: (input) =>
          Effect.sync(() => calls.push(input)).pipe(
            Effect.andThen(
              behavior === "fail"
                ? Effect.fail(new Error(`${id} failed`))
                : Effect.succeed(
                    behavior === "empty"
                      ? []
                      : [
                          {
                            url: `https://${id}.example.com`,
                            title: input.query,
                            content: `${id}: ${input.query}`,
                            time: {},
                          },
                        ],
                  ),
            ),
          ),
      })
    })
    return { providerID, calls }
  })

describe("WebSearch", () => {
  it.effect("executes an explicit provider without changing the default", () =>
    Effect.gen(function* () {
      yield* register("exa")
      const parallel = yield* register("parallel")
      const websearch = yield* WebSearch.Service

      expect(yield* websearch.query({ query: "effect", providerID: parallel.providerID })).toEqual(
        new WebSearch.Response({
          providerID: parallel.providerID,
          results: [
            {
              url: "https://parallel.example.com",
              title: "effect",
              content: "parallel: effect",
              time: {},
            },
          ],
        }),
      )
      expect((yield* websearch.query({ query: "default" }).pipe(Effect.flip))._tag).toBe("WebSearch.ProviderRequired")
      expect(parallel.calls).toEqual([{ query: "effect" }])
    }),
  )

  it.effect("keeps explicit providers strict when automatic selection is enabled", () =>
    Effect.gen(function* () {
      const exa = yield* register("exa", "fail")
      const parallel = yield* register("parallel")
      const websearch = yield* WebSearch.Service
      yield* websearch.transform((draft) => draft.default.set(WebSearch.AUTO))

      const error = yield* websearch.query({ query: "strict", providerID: exa.providerID }).pipe(Effect.flip)

      expect(error).toMatchObject({ _tag: "WebSearch.Request", providerID: exa.providerID })
      expect(exa.calls).toEqual([{ query: "strict" }])
      expect(parallel.calls).toEqual([])
    }),
  )

  it.effect("requires a provider when no default is set", () =>
    Effect.gen(function* () {
      yield* register("exa")
      yield* register("parallel")
      const websearch = yield* WebSearch.Service

      expect((yield* websearch.query({ query: "layers" }).pipe(Effect.flip))._tag).toBe("WebSearch.ProviderRequired")
    }),
  )

  it.effect("uses the default set by a transform", () =>
    Effect.gen(function* () {
      yield* register("exa")
      const parallel = yield* register("parallel")
      const websearch = yield* WebSearch.Service
      yield* websearch.transform((draft) => draft.default.set(parallel.providerID))

      expect((yield* websearch.query({ query: "configured" })).providerID).toBe(parallel.providerID)
    }),
  )

  it.effect("keeps fixed configured providers strict", () =>
    Effect.gen(function* () {
      const exa = yield* register("exa", "fail")
      const parallel = yield* register("parallel")
      const websearch = yield* WebSearch.Service
      yield* websearch.transform((draft) => draft.default.set(exa.providerID))

      const error = yield* websearch.query({ query: "configured" }).pipe(Effect.flip)

      expect(error).toMatchObject({ _tag: "WebSearch.Request", providerID: exa.providerID })
      expect(parallel.calls).toEqual([])
    }),
  )

  it.effect("uses the provider stored in KV", () =>
    Effect.gen(function* () {
      yield* register("exa")
      const parallel = yield* register("parallel")
      const websearch = yield* WebSearch.Service
      const kv = yield* KV.Service
      yield* kv.set("websearch:provider", parallel.providerID)

      expect((yield* websearch.query({ query: "stored" })).providerID).toBe(parallel.providerID)
      yield* kv.remove("websearch:provider")
    }),
  )

  it.effect("keeps fixed KV providers strict", () =>
    Effect.gen(function* () {
      const exa = yield* register("exa", "fail")
      const parallel = yield* register("parallel")
      const websearch = yield* WebSearch.Service
      const kv = yield* KV.Service
      yield* kv.set("websearch:provider", exa.providerID)

      const error = yield* websearch.query({ query: "fixed" }).pipe(Effect.flip)

      expect(error).toMatchObject({ _tag: "WebSearch.Request", providerID: exa.providerID })
      expect(parallel.calls).toEqual([])
      yield* kv.remove("websearch:provider")
    }),
  )

  it.effect("automatically tries each provider at most once until one succeeds", () =>
    Effect.gen(function* () {
      const order = yield* Random.shuffle(["exa", "parallel", "firecrawl"]).pipe(Random.withSeed("fallback"))
      const registered = yield* Effect.forEach(["exa", "parallel", "firecrawl"], (id) =>
        register(id, id === order.at(-1) ? "results" : "fail"),
      )
      const websearch = yield* WebSearch.Service
      const kv = yield* KV.Service
      yield* kv.set("websearch:provider", WebSearch.AUTO)

      const response = yield* websearch.query({ query: "automatic" }).pipe(Random.withSeed("fallback"))

      expect(response.providerID).toBe(WebSearch.ID.make(order.at(-1)!))
      expect(registered.flatMap((provider) => provider.calls)).toHaveLength(3)
      expect(registered.every((provider) => provider.calls.length === 1)).toBe(true)
      yield* kv.remove("websearch:provider")
    }),
  )

  it.effect("stops automatic fallback on empty results", () =>
    Effect.gen(function* () {
      const empty = yield* register("empty", "empty")
      const fallback = yield* register("fallback")
      const websearch = yield* WebSearch.Service
      yield* websearch.transform((draft) => draft.default.set(WebSearch.AUTO))

      const response = yield* websearch.query({ query: "empty" }).pipe(Random.withSeed("empty-first"))

      expect(response.results).toEqual([])
      expect(empty.calls).toHaveLength(1)
      expect(fallback.calls).toHaveLength(0)
    }),
  )

  it.effect("returns the final request error when every automatic provider fails", () =>
    Effect.gen(function* () {
      const exa = yield* register("exa", "fail")
      const parallel = yield* register("parallel", "fail")
      const websearch = yield* WebSearch.Service
      yield* websearch.transform((draft) => draft.default.set(WebSearch.AUTO))
      const expected = yield* Random.shuffle([exa.providerID, parallel.providerID]).pipe(Random.withSeed("all-fail"))

      const error = yield* websearch.query({ query: "failure" }).pipe(Random.withSeed("all-fail"), Effect.flip)

      expect(error).toMatchObject({ _tag: "WebSearch.Request", providerID: expected.at(-1) })
      expect(exa.calls).toHaveLength(1)
      expect(parallel.calls).toHaveLength(1)
    }),
  )

  it.effect("supports zero and one registered provider in automatic mode", () =>
    Effect.gen(function* () {
      const websearch = yield* WebSearch.Service
      yield* websearch.transform((draft) => draft.default.set(WebSearch.AUTO))
      expect((yield* websearch.query({ query: "zero" }).pipe(Effect.flip))._tag).toBe("WebSearch.ProviderRequired")

      const only = yield* register("only")
      expect((yield* websearch.query({ query: "one" })).providerID).toBe(only.providerID)
      expect(only.calls).toHaveLength(1)
    }),
  )

  it.effect("lets an automatic configured default override a fixed KV provider", () =>
    Effect.gen(function* () {
      const fixed = yield* register("fixed", "fail")
      const fallback = yield* register("fallback")
      const websearch = yield* WebSearch.Service
      const kv = yield* KV.Service
      yield* kv.set("websearch:provider", fixed.providerID)
      yield* websearch.transform((draft) => draft.default.set(WebSearch.AUTO))

      expect((yield* websearch.query({ query: "config" })).providerID).toBe(fallback.providerID)
      expect(fixed.calls.length).toBeLessThanOrEqual(1)
      expect(fallback.calls).toHaveLength(1)
      yield* kv.remove("websearch:provider")
    }),
  )

  it.effect("can start automatic selection with any registered provider", () =>
    Effect.gen(function* () {
      const exa = yield* register("exa")
      const parallel = yield* register("parallel")
      const websearch = yield* WebSearch.Service
      yield* websearch.transform((draft) => draft.default.set(WebSearch.AUTO))

      const selected = yield* Effect.forEach(["a", "b", "c", "d", "e", "f"], (seed) =>
        websearch.query({ query: seed }).pipe(
          Random.withSeed(seed),
          Effect.map((response) => response.providerID),
        ),
      )

      expect(new Set(selected)).toEqual(new Set([exa.providerID, parallel.providerID]))
    }),
  )

  it.effect("fails when web search is explicitly disabled", () =>
    Effect.gen(function* () {
      yield* register("exa")
      const websearch = yield* WebSearch.Service
      const kv = yield* KV.Service
      yield* kv.set("websearch:provider", false)

      expect((yield* websearch.query({ query: "disabled" }).pipe(Effect.flip))._tag).toBe("WebSearch.Disabled")
      yield* kv.remove("websearch:provider")
    }),
  )

  it.effect("falls back when the configured default is unavailable", () =>
    Effect.gen(function* () {
      yield* register("exa")
      const websearch = yield* WebSearch.Service
      yield* websearch.transform((draft) => draft.default.set(WebSearch.ID.make("missing")))

      expect((yield* websearch.query({ query: "fallback" }).pipe(Effect.flip))._tag).toBe("WebSearch.ProviderRequired")
    }),
  )

  it.effect("removes scoped provider registrations", () =>
    Effect.gen(function* () {
      const websearch = yield* WebSearch.Service
      const scope = yield* Scope.fork(yield* Scope.Scope)
      const provider = yield* register("temporary").pipe(Scope.provide(scope))
      expect(yield* websearch.providers()).toContainEqual({ id: provider.providerID, name: "TEMPORARY" })
      yield* Scope.close(scope, Exit.void)
      expect(yield* websearch.providers()).not.toContainEqual({ id: provider.providerID, name: "TEMPORARY" })
    }),
  )
})
