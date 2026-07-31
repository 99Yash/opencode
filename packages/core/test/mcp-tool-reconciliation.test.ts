import { expect, test } from "bun:test"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Bus } from "@opencode-ai/core/bus"
import { Image } from "@opencode-ai/core/image"
import { MCP } from "@opencode-ai/core/mcp/index"
import { Permission } from "@opencode-ai/core/permission"
import { McpTool } from "@opencode-ai/core/tool/mcp"
import { Tool } from "@opencode-ai/core/tool"
import { LayerNode } from "@opencode-ai/util/effect/layer-node"
import { Deferred, Effect, Fiber, Layer, PubSub, Stream } from "effect"
import { imagePassthrough } from "./lib/image"

test("explicitly fences asynchronous MCP tool reconciliation", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const initialRead = yield* Deferred.make<void>()
        const reconcileStarted = yield* Deferred.make<void>()
        const releaseReconcile = yield* Deferred.make<void>()
        const updates = yield* PubSub.unbounded<void>()
        let reads = 0
        let catalog: Array<MCP.Tool> = []

        const layer = AppNodeBuilder.build(LayerNode.group([Tool.node, McpTool.node]), [
          [
            MCP.node,
            Layer.mock(MCP.Service, {
              tools: () =>
                Effect.gen(function* () {
                  reads += 1
                  if (reads === 1) {
                    const current = catalog
                    yield* Deferred.succeed(initialRead, undefined)
                    return current
                  }
                  yield* Deferred.succeed(reconcileStarted, undefined)
                  yield* Deferred.await(releaseReconcile)
                  return catalog
                }),
            }),
          ],
          [Bus.node, Layer.mock(Bus.Service, { subscribe: () => Stream.fromPubSub(updates) as never })],
          [Permission.node, Layer.mock(Permission.Service, {})],
          [Image.node, imagePassthrough],
        ])

        yield* Effect.gen(function* () {
          const registry = yield* Tool.Service
          const adapter = yield* McpTool.Service
          yield* Deferred.await(initialRead)
          catalog = [
            new MCP.Tool({
              server: MCP.ServerName.make("voice"),
              name: "list_open_tabs",
              inputSchema: { type: "object", properties: {} },
            }),
          ]

          yield* PubSub.publish(updates, undefined)
          yield* Deferred.await(reconcileStarted)

          const stale = yield* registry.snapshot()
          expect(stale.codeModeCatalog?.some((entry) => entry.path === "voice.list_open_tabs")).toBe(false)

          const fence = yield* Effect.forkChild(adapter.reconcile, { startImmediately: true })
          expect(fence.pollUnsafe()).toBeUndefined()
          yield* Deferred.succeed(releaseReconcile, undefined)
          yield* Fiber.join(fence)
          const current = yield* registry.snapshot()
          expect(current.codeModeCatalog?.some((entry) => entry.path === "voice.list_open_tabs")).toBe(true)
        }).pipe(Effect.provide(layer))
      }),
    ),
  )
})
