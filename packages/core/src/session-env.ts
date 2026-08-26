export * as SessionEnv from "./session-env.js"

import { Context, Effect, Layer, Scope } from "effect"
import { LayerNode } from "@opencode-ai/util/effect/layer-node"
import { Node, makeGlobalNode } from "@opencode-ai/util/effect/app-node"
import { Agent } from "./agent.js"
import { Catalog } from "./catalog.js"
import { Location } from "./location.js"
import { McpInstructions } from "./mcp/instructions.js"
import { McpTool } from "./tool/mcp.js"
import { PluginSupervisor } from "./plugin/supervisor.js"
import { Session } from "./session.js"
import { SessionEnvBindings } from "./session/env-bindings.js"
import { SessionRunnerModel } from "./session/runner/model.js"
import { SessionSchema } from "./session/schema.js"
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
  /**
   * Fixed model for every drain in this environment, bypassing catalog
   * resolution (SessionRunnerModel.resolved is the values-side constructor).
   * Omit to resolve through the populated catalog instead.
   */
  readonly model?: SessionRunnerModel.Resolved
  /** Capture filesystem snapshots around attempts. Defaults to false. */
  readonly snapshots?: boolean
  readonly tools?: Parameters<Tool.Interface["transform"]>[0]
  readonly agents?: (draft: Agent.Draft) => void
  readonly catalog?: (draft: Catalog.Draft) => void
}

type PromptInput = Omit<Parameters<Session.Interface["prompt"]>[0], "sessionID">
type SessionInput = Omit<Parameters<Session.Interface["create"]>[0], "location" | "parentID">

export interface SessionHandle {
  readonly id: SessionSchema.ID
  readonly prompt: (input: PromptInput) => ReturnType<Session.Interface["prompt"]>
  readonly interrupt: (options?: { readonly continue?: boolean }) => Effect.Effect<boolean>
}

export interface Handle {
  readonly context: Context.Context<SessionEnv>
  /**
   * Ensure a durable session and bind it to this environment. Reusing a
   * Session ID adopts the existing Session (creation args are ignored then),
   * so reconnection after a restart is the same call with the same ID. The
   * binding lives until the caller's scope closes; drains resolve the bound
   * graph instead of the Session's Location graph.
   */
  readonly session: (input?: SessionInput) => Effect.Effect<SessionHandle, Session.NotFoundError, Scope.Scope>
}

export interface Interface {
  readonly make: (options: Options) => Effect.Effect<Handle, unknown, Scope.Scope>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionEnv") {}

/**
 * Captures the application root's MemoMap at construction (the same trick
 * LayerMap.make uses), so each environment's hoisted global nodes dedupe
 * against the running Database, Bus, and SessionStore instead of building
 * second instances. The engine subtree itself builds fresh per environment.
 *
 * Like buildLocationServiceMap, the layer must receive the application
 * root's replacements: hoisted globals otherwise compile their original
 * implementations and a composed root (test harness, embedded host) would
 * build second, differently-configured instances.
 */
const layerWith = (base: LayerNode.Replacements) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const memoMap = Layer.CurrentMemoMap.forkOrCreate(yield* Effect.context<never>())
      const bindings = yield* SessionEnvBindings.Service
      const sessions = yield* Session.Service

      const make = Effect.fn("SessionEnv.make")(function* (options: Options) {
        const scope = yield* Effect.scope
        // Later entries win in the replacement map, so environment-specific
        // substitutions override same-node entries from the application root.
        const replacements: LayerNode.Replacements = [
          ...base,
          [Location.node, Location.boundNode(Location.Ref.make({ directory: options.directory }))],
          [PluginSupervisor.node, PluginSupervisor.ready],
          [McpTool.node, McpTool.noop],
          [McpInstructions.node, McpInstructions.noop],
          ...(options.snapshots === true ? [] : [[Snapshot.node, Snapshot.noopLayer] as const]),
          ...(options.model === undefined
            ? []
            : [[SessionRunnerModel.node, fixedModel(options.model)] as const]),
        ]
        const sliced = LayerNode.hoist(sessionEnvGroup, Node.tags.values.global, replacements)
        const engine = LayerNode.compile(sliced.node).pipe(
          Layer.fresh,
          Layer.provide(LayerNode.compile(sliced.hoisted)),
        )
        const context = yield* Layer.buildWithMemoMap(engine, memoMap, scope)

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

        const session = Effect.fn("SessionEnv.session")(function* (input?: SessionInput) {
          // Create-or-adopt: ID reuse returns the existing durable Session, and the
          // binding outranks its recorded Location even if the directories differ.
          const info = yield* sessions.create({
            ...input,
            location: Location.Ref.make({ directory: options.directory }),
          })
          yield* bindings.bind(info.id, context)
          return {
            id: info.id,
            prompt: (input: PromptInput) => sessions.prompt({ ...input, sessionID: info.id }),
            interrupt: (options?: { readonly continue?: boolean }) => sessions.interrupt(info.id, options),
          } as const
        })

        return { context, session } as const
      })

      return Service.of({ make })
    }),
  )

const fixedModel = (resolved: SessionRunnerModel.Resolved) =>
  Layer.succeed(SessionRunnerModel.Service, SessionRunnerModel.Service.of({ resolve: () => Effect.succeed(resolved) }))

/** Thread the application root's replacements through, mirroring buildLocationServiceMap. */
export const configured = (replacements: LayerNode.Replacements = []) =>
  makeGlobalNode({ service: Service, layer: layerWith(replacements), deps: [SessionEnvBindings.node, Session.node] })

export const node = configured()
