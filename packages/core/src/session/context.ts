export * as SessionContext from "./context.js"

import { Context, Effect, Layer, Schema } from "effect"
import { Agent } from "../agent.js"
import { Catalog } from "../catalog.js"
import { CodeModeInstructions } from "../codemode/instructions.js"
import { Database } from "../database/database.js"
import { makeLocationNode } from "@opencode-ai/util/effect/app-node"
import { InstructionDiscovery } from "../instruction-discovery.js"
import { Instructions } from "../instructions/index.js"
import { InstructionBuiltIns } from "../instructions/builtins.js"
import { Location } from "../location.js"
import { McpInstructions } from "../mcp/instructions.js"
import { McpTool } from "../tool/mcp.js"
import { Model } from "../model.js"
import { PluginSupervisor } from "../plugin/supervisor.js"
import { ReferenceInstructions } from "../reference/instructions.js"
import { SkillInstructions } from "../skill/instructions.js"
import { Tool } from "../tool.js"
import { Permission } from "../permission.js"
import { Permissions } from "../permissions.js"
import { Image } from "../image.js"
import { PluginHooks } from "../plugin/hooks.js"
import { Source } from "../source.js"
import type { SessionCapabilities } from "./capabilities.js"
import { SessionSystemPrompt } from "./system-prompt.js"
import { AgentNotFoundError } from "./error.js"
import { SessionHistory } from "./history.js"
import { InstructionEntry } from "./instruction-entry.js"
import { SessionMessage } from "./message.js"
import { SessionModelRequest } from "./model-request.js"
import { SessionRunnerModel } from "./runner/model.js"
import { SessionSchema } from "./schema.js"
import { SessionStore } from "./store.js"

export interface Selection {
  readonly session: SessionSchema.Info
  readonly agent: Agent.Selection & { readonly info: Agent.Info }
  readonly instructions: Instructions.List
  readonly tools: Tool.Snapshot
  readonly system?: string
}

export interface Loaded {
  readonly session: SessionSchema.Info
  readonly agent: Agent.Selection & { readonly info: Agent.Info }
  readonly model: SessionRunnerModel.Resolved
  readonly initial: string
  readonly messages: ReadonlyArray<SessionMessage.Info>
  readonly tools: Tool.Snapshot
  readonly system?: string
}

/**
 * Resolves model-request state in two phases: `select` fixes the Session,
 * agent, instruction sources, and tool snapshot; `load` adds the model and
 * active history for that selection. Auxiliary operations resolve only the
 * capabilities they need; request preparation stays separate from selection.
 */
export interface Interface {
  /** Selects the Session, agent, instructions, and tools used by subsequent work. */
  readonly select: (sessionID: SessionSchema.ID) => Effect.Effect<Selection, AgentNotFoundError>
  /** Resolves the model and active history for that selection. */
  readonly load: (selection: Selection) => Effect.Effect<Loaded, SessionRunnerModel.Error>
  readonly resolveModel: (
    session: SessionSchema.Info,
  ) => Effect.Effect<SessionRunnerModel.Resolved, SessionRunnerModel.Error>
  /** Selects auxiliary title capabilities without instruction or tool preflight. */
  readonly selectTitle: (session: SessionSchema.Info) => Effect.Effect<
    | {
        readonly agent: Agent.Info
        readonly primary: SessionRunnerModel.Resolved | undefined
        readonly selected: SessionRunnerModel.Resolved
      }
    | undefined
  >
  readonly prepare: SessionModelRequest.Interface["prepare"]
}

/** Location-scoped model-context loader for durable Session Steps. */
export class Service extends Context.Service<Service, Interface>()("@opencode/SessionContext") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const agents = yield* Agent.Service
    const builtins = yield* InstructionBuiltIns.Service
    const catalog = yield* Catalog.Service
    const db = (yield* Database.Service).db
    const discovery = yield* InstructionDiscovery.Service
    const entries = yield* InstructionEntry.Service
    const location = yield* Location.Service
    const mcpInstructions = yield* McpInstructions.Service
    const mcpTools = yield* McpTool.Service
    const models = yield* SessionRunnerModel.Service
    const modelRequests = yield* SessionModelRequest.Service
    const plugins = yield* PluginSupervisor.Service
    const referenceInstructions = yield* ReferenceInstructions.Service
    const skillInstructions = yield* SkillInstructions.Service
    const store = yield* SessionStore.Service
    const registry = yield* Tool.Service

    const resolveModel = (session: SessionSchema.Info) => models.resolve(session, catalog.model.available)

    const selectTitle = Effect.fn("SessionContext.selectTitle")(function* (session: SessionSchema.Info) {
      const agent = yield* agents.get(Agent.ID.make("title"))
      if (!agent) return
      const primary = yield* resolveModel(session).pipe(Effect.orElseSucceed(() => undefined))
      const info = yield* Effect.gen(function* () {
        if (agent.model) return yield* catalog.model.get(agent.model.providerID, agent.model.id)
        if (!primary) return
        return yield* catalog.model.small(primary.ref.providerID)
      })
      const variant =
        agent.model?.variant ?? MINIMAL_REASONING_VARIANTS.find((id) => info?.variants.some((item) => item.id === id))
      const preferred =
        info &&
        (yield* resolveModel({
          ...session,
          model: Model.Ref.make({
            providerID: info.providerID,
            id: info.id,
            ...(variant ? { variant } : {}),
          }),
        }).pipe(Effect.orElseSucceed(() => undefined)))
      const selected = preferred ?? primary
      if (!selected) return
      return { agent, primary, selected }
    })

    const select = Effect.fn("SessionContext.select")(function* (sessionID: SessionSchema.ID) {
      const session = yield* store.get(sessionID)
      if (!session) return yield* Effect.die(new Error(`Session not found: ${sessionID}`))
      if (session.location.directory !== location.directory || session.location.workspaceID !== location.workspaceID)
        return yield* Effect.interrupt

      yield* plugins.flush
      yield* mcpTools.flush
      const agent = yield* agents.select(session.agent)
      if (!agent.info) return yield* new AgentNotFoundError({ sessionID: session.id, agent: session.agent ?? agent.id })
      const loaded = yield* Effect.all(
        {
          tools: registry.snapshot(agent.info.permissions),
          builtins: builtins.load(sessionID),
          discovery: discovery.load(),
          skills: skillInstructions.load(agent),
          references: referenceInstructions.load(),
          mcp: mcpInstructions.load(agent),
          entries: entries.load(sessionID),
        },
        { concurrency: "unbounded" },
      )
      return {
        session,
        agent: { ...agent, info: agent.info },
        instructions: Instructions.combine([
          loaded.builtins,
          CodeModeInstructions.make(loaded.tools.codeModeCatalog),
          loaded.discovery,
          loaded.skills,
          loaded.references,
          loaded.mcp,
          loaded.entries,
        ]),
        tools: loaded.tools,
      }
    })

    return Service.of({
      select,
      load: load(db, resolveModel),
      resolveModel,
      selectTitle,
      prepare: modelRequests.prepare,
    })
  }),
)

/** The values path shares instruction persistence and history assembly with discovery. */
export const values = (input: SessionCapabilities.OpenInput) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const store = yield* SessionStore.Service
      const entries = yield* InstructionEntry.Service
      const requests = yield* SessionModelRequest.Service
      const hooks = yield* PluginHooks.Service
      const image = yield* Image.Service
      const tools = Source.from(input.tools ?? [])
      const instructions = Source.from(input.instructions ?? [])
      const limits = Source.from(input.limits ?? {})
      const permissions = input.permissions ?? Permissions.allowAll
      const model = Source.from(input.model)
      const resolveModel: Interface["resolveModel"] = (session) => model.get(session)
      const select: Interface["select"] = Effect.fn("SessionContext.selectValues")(function* (sessionID) {
        const session = yield* store.get(sessionID)
        if (!session) return yield* Effect.die(new Error(`Session not found: ${sessionID}`))
        const rules = yield* permissions.visibility.get(session)
        const selected = yield* Effect.all({ tools: tools.get(session), limits: limits.get(session) })
        const snapshot = yield* Tool.snapshot(selected.tools, rules).pipe(
          Effect.provideService(PluginHooks.Service, hooks),
          Effect.provideService(Image.Service, image),
        )
        const id = session.agent ?? Agent.defaultID
        return {
          session,
          agent: { id, info: { ...Agent.Info.default(id), permissions: rules, steps: selected.limits.steps } },
          // System text participates in the epoch instead of changing the privileged prefix.
          system: "",
          tools: snapshot,
          instructions: Instructions.combine([
            Instructions.make({
              key: Instructions.Key.make("session/system"),
              codec: Schema.String,
              read:
                input.system === undefined
                  ? Effect.succeed(SessionSystemPrompt.make(snapshot.definitions.map((tool) => tool.name)))
                  : Source.from(input.system)
                      .get(session)
                      .pipe(Effect.map((value) => (value === "" ? Instructions.removed : value))),
              render: {
                initial: (value) => value,
                changed: (_previous, value) =>
                  `The system instructions changed and supersede the previous value:\n${value}`,
                removed: () => "The previous system instructions no longer apply.",
              },
            }),
            CodeModeInstructions.make(snapshot.codeModeCatalog),
            Instructions.make({
              key: Instructions.Key.make("session/instructions"),
              codec: Schema.Array(Schema.String),
              read: instructions
                .get(session)
                .pipe(
                  Effect.map((value) =>
                    Array.isArray(value) && !value.some((part) => part.length > 0) ? Instructions.removed : value,
                  ),
                ),
              render: {
                initial: (value) => value.join("\n\n"),
                changed: (_previous, value) =>
                  `The session instructions changed and supersede the previous value:\n${value.join("\n\n")}`,
                removed: () => "The previous session instructions no longer apply.",
              },
            }),
            Instructions.make({
              key: Instructions.Key.make("session/permissions"),
              codec: Schema.toCodecJson(Permission.Ruleset),
              read: Effect.succeed(rules.length > 0 ? rules : Instructions.removed),
              render: {
                initial: (value) => `Permission rules:\n${JSON.stringify(value)}`,
                changed: (_previous, value) => `Permission rules changed:\n${JSON.stringify(value)}`,
                removed: () => "The previous permission rules no longer apply.",
              },
            }),
            yield* entries.load(sessionID),
          ]),
        }
      })
      return Service.of({
        select,
        load: load(db, resolveModel),
        resolveModel,
        selectTitle: () => Effect.undefined,
        prepare: requests.prepare,
      })
    }),
  )

function load(db: Database.Interface["db"], resolveModel: Interface["resolveModel"]): Interface["load"] {
  return Effect.fn("SessionContext.load")(function* (selection: Selection) {
    const model = yield* resolveModel(selection.session)
    const history = yield* SessionHistory.entriesForRunner(db, selection.session.id, selection.instructions)
    return {
      session: selection.session,
      agent: selection.agent,
      model,
      initial: history.initial,
      messages: history.entries.map((entry) => entry.message),
      tools: selection.tools,
      ...(selection.system === undefined ? {} : { system: selection.system }),
    }
  })
}

/** Variant IDs that minimize reasoning output, in preference order. */
const MINIMAL_REASONING_VARIANTS = ["none", "minimal", "low"].map((id) => Model.VariantID.make(id))

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [
    Agent.node,
    Catalog.node,
    Database.node,
    InstructionBuiltIns.node,
    InstructionDiscovery.node,
    InstructionEntry.node,
    Location.node,
    McpInstructions.node,
    McpTool.node,
    PluginSupervisor.node,
    ReferenceInstructions.node,
    SessionRunnerModel.node,
    SessionModelRequest.node,
    SessionStore.node,
    SkillInstructions.node,
    Tool.node,
  ],
})
