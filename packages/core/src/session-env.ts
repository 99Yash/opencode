export * as SessionEnv from "./session-env.js"

import { Context, Effect, Layer, Scope } from "effect"
import { LayerNode } from "@opencode-ai/util/effect/layer-node"
import { Node } from "@opencode-ai/util/effect/app-node"
import { Agent } from "./agent.js"
import { Catalog } from "./catalog.js"
import { Location } from "./location.js"
import { McpInstructions } from "./mcp/instructions.js"
import { McpTool } from "./tool/mcp.js"
import { PluginSupervisor } from "./plugin/supervisor.js"
import { Snapshot } from "./snapshot.js"
import { Tool } from "./tool.js"
import { sessionEnvGroup, type SessionEnv } from "./location-services.js"
import type { AbsolutePath } from "./schema.js"

/**
 * Values-constructed session environment: the engine tier of the location
 * graph, booted without discovery, plugins, or MCP. Capabilities arrive
 * through the same draft APIs plugins use, so registry invariants (hook
 * wiring, image normalization, permission gating) hold by construction.
 */
export interface Options {
  readonly directory: AbsolutePath
  /** Capture filesystem snapshots around attempts. Defaults to false. */
  readonly snapshots?: boolean
  readonly tools?: Parameters<Tool.Interface["transform"]>[0]
  readonly agents?: (draft: Agent.Draft) => void
  readonly catalog?: (draft: Catalog.Draft) => void
}

/**
 * Build one live engine graph in the caller's scope and populate it from
 * options. The hoisted global nodes compile to the same Layer references the
 * application root built, so memoization reuses the running Database, Bus,
 * and SessionStore rather than constructing second instances.
 */
export const make = Effect.fn("SessionEnv.make")(function* (options: Options) {
  const replacements: LayerNode.Replacements = [
    [Location.node, Location.boundNode(Location.Ref.make({ directory: options.directory }))],
    [PluginSupervisor.node, PluginSupervisor.ready],
    [McpTool.node, McpTool.noop],
    [McpInstructions.node, McpInstructions.noop],
    ...(options.snapshots === true ? [] : [[Snapshot.node, Snapshot.noopLayer] as const]),
  ]
  const sliced = LayerNode.hoist(sessionEnvGroup, Node.tags.values.global, replacements)
  const layer = LayerNode.compile(sliced.node).pipe(
    Layer.fresh,
    Layer.provide(LayerNode.compile(sliced.hoisted)),
  )
  const context = yield* Layer.build(layer)

  const scope = yield* Effect.scope
  const populate = Effect.gen(function* () {
    if (options.tools) {
      const tools = yield* Tool.Service
      yield* tools.transform(options.tools)
    }
    if (options.agents) {
      const agents = yield* Agent.Service
      yield* agents.transform(options.agents)
    }
    if (options.catalog) {
      const catalog = yield* Catalog.Service
      yield* catalog.transform(options.catalog)
    }
  })
  yield* populate.pipe(Effect.provide(context), Effect.provideService(Scope.Scope, scope))

  return { context } as const
})

export type Handle = Effect.Success<ReturnType<typeof make>>
export type Services = SessionEnv
export type EnvContext = Context.Context<SessionEnv>
