export * as SessionResolve from "./resolve.js"

import type { LLMClientService } from "@opencode-ai/ai"
import { FSUtil } from "@opencode-ai/util/fs-util"
import { Global } from "@opencode-ai/util/global"
import { makeGlobalNode } from "@opencode-ai/util/effect/app-node"
import { Context, Deferred, Effect, Exit, Layer, Scope } from "effect"
import { Bus } from "../bus.js"
import { App } from "../app.js"
import { Database } from "../database/database.js"
import { llmClient, webSocketConstructor } from "../effect/app-node-platform.js"
import { KV } from "../kv.js"
import type { SessionCapabilities } from "./capabilities.js"
import type { SessionRunner } from "./runner/index.js"
import { SessionSchema } from "./schema.js"
import { SessionStore } from "./store.js"
import { Socket } from "effect/unstable/socket"
import type { Image } from "../image.js"
import type { SessionContext } from "./context.js"
import type { SessionModelTransport } from "./model-transport.js"

const prefix = "session.capabilities/"

/**
 * Live operations, never an attempt snapshot. Title, request hooks, compaction,
 * media/skills, snapshots, output, and transport customization are deferred;
 * open supplies their internal defaults without directory discovery.
 */
interface Capabilities extends SessionContext.Interface {
  readonly image: Image.Interface
  readonly transport: SessionModelTransport.Interface
}

type Status = "attached" | "owned-detached" | "unowned"
type Resolved =
  | { readonly status: "attached"; readonly capabilities: Capabilities }
  | { readonly status: "owned-detached" | "unowned" }

type Opened = {
  readonly capabilities: Capabilities
  readonly runner: SessionRunner.Interface
  readonly scope: Scope.Closeable
  readonly onRetire: () => Effect.Effect<void>
  readonly done: Deferred.Deferred<void>
  current: boolean
  users: number
}

export interface Interface {
  readonly own: <A extends { readonly id: SessionSchema.ID }, R>(
    record: Effect.Effect<A, never, R>,
  ) => Effect.Effect<A, never, R>
  readonly status: (id: SessionSchema.ID) => Status
  readonly ownedIDs: Effect.Effect<ReadonlyArray<SessionSchema.ID>>
  readonly attach: (
    id: SessionSchema.ID,
    input: SessionCapabilities.OpenInput,
  ) => Effect.Effect<() => Effect.Effect<void>>
  readonly resolve: (session: SessionSchema.Info) => Effect.Effect<Resolved, never, Scope.Scope>
  /** Called synchronously when the coordinator installs a busy period, before its first fiber yield. */
  readonly pin: (id: SessionSchema.ID) => void
  readonly pinned: (id: SessionSchema.ID) => SessionRunner.Interface | undefined
  readonly settle: (id: SessionSchema.ID) => Effect.Effect<void>
  readonly remove: (id: SessionSchema.ID) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionResolve") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const kv = yield* KV.Service
    const db = (yield* Database.Service).db
    const owned = new Set(
      (yield* kv.scanAll(prefix))
        .filter((entry) => entry.value === true)
        .map((entry) => SessionSchema.ID.make(entry.key.slice(prefix.length))),
    )
    const globals = yield* Effect.context<
      | Database.Service
      | Bus.Service
      | SessionStore.Service
      | LLMClientService
      | FSUtil.Service
      | Global.Service
      | Socket.WebSocketConstructor
    >()
    const current = new Map<SessionSchema.ID, Opened>()
    const pinned = new Map<SessionSchema.ID, Opened>()
    const opened = new Map<Deferred.Deferred<void>, Opened>()
    // LayerMap invalidation cannot choose synchronously at coordinator start or
    // run a host hook after all generation-specific users settle. Keep explicit leases.
    const retire = (value: Opened) =>
      Effect.suspend(() => {
        if (value.current || value.users > 0 || !opened.delete(value.done)) return Effect.void
        return Scope.close(value.scope, Exit.void).pipe(
          Effect.andThen(value.onRetire()),
          Effect.onExit((exit) => Deferred.done(value.done, exit)),
        )
      })
    const release = (value: Opened) =>
      Effect.sync(() => {
        value.users--
      }).pipe(Effect.andThen(retire(value)))
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => current.clear()).pipe(
        Effect.andThen(
          Effect.forEach(
            opened.values(),
            (value) => {
              value.current = false
              return retire(value)
            },
            { discard: true },
          ),
        ),
      ),
    )

    return Service.of({
      // Ownership is transitionally one-way: retirement never hands a Session back to discovery.
      own: (record) =>
        Effect.uninterruptible(
          Effect.gen(function* () {
            const session = yield* db
              .transaction(() =>
                Effect.gen(function* () {
                  const session = yield* record
                  if (!owned.has(session.id)) yield* kv.set(prefix + session.id, true)
                  return session
                }),
              )
              .pipe(Effect.orDie)
            // Publish the memory index only after the durable transaction commits.
            owned.add(session.id)
            return session
          }),
        ),
      status: (id) => (current.has(id) ? "attached" : owned.has(id) ? "owned-detached" : "unowned"),
      ownedIDs: Effect.sync(() => Array.from(owned)),
      attach: Effect.fn("SessionResolve.attach")(function* (id, input) {
        const [
          { Image },
          { PluginHooks },
          { PluginSupervisor },
          { Snapshot },
          { ToolOutput },
          { SessionCompaction },
          { SessionContext },
          { InstructionEntry },
          { SessionModelRequest },
          { SessionModelTransport },
          { SessionRunner },
          { SessionRunnerLLM },
          { SessionTitle },
        ] = yield* Effect.promise(() =>
          Promise.all([
            import("../image.js"),
            import("../plugin/hooks.js"),
            import("../plugin/supervisor-service.js"),
            import("../snapshot.js"),
            import("../tool-output.js"),
            import("./compaction.js"),
            import("./context.js"),
            import("./instruction-entry.js"),
            import("./model-request.js"),
            import("./model-transport.js"),
            import("./runner/index.js"),
            import("./runner/llm.js"),
            import("./title.js"),
          ]),
        )
        const scope = yield* Scope.make()
        const base = Layer.mergeAll(
          PluginHooks.layer,
          Image.layer,
          InstructionEntry.layer,
          SessionModelTransport.layer,
          ToolOutput.layer,
          Snapshot.noopLayer,
          SessionCompaction.layer,
          Layer.succeed(PluginSupervisor.Service, { flush: Effect.void }),
        ).pipe(Layer.provide(Layer.succeedContext(globals)))
        const requests = SessionModelRequest.layer.pipe(Layer.provideMerge(base))
        const capabilities = SessionContext.values(input).pipe(Layer.provideMerge(requests))
        const runner = SessionRunnerLLM.layer.pipe(
          Layer.provideMerge(SessionTitle.layer.pipe(Layer.provideMerge(capabilities))),
          Layer.provide(Layer.succeedContext(globals)),
        )
        // Each open builds fresh local state over the SAME captured durable/global services.
        const services = yield* Layer.buildWithScope(Layer.fresh(runner), scope).pipe(
          Effect.onError(() => Scope.close(scope, Exit.void)),
        )
        const value: Opened = {
          capabilities: {
            ...Context.get(services, SessionContext.Service),
            image: Context.get(services, Image.Service),
            transport: Context.get(services, SessionModelTransport.Service),
          },
          runner: Context.get(services, SessionRunner.Service),
          scope,
          onRetire: input.retire ?? (() => Effect.void),
          done: Deferred.makeUnsafe<void>(),
          current: true,
          users: 0,
        }
        const previous = current.get(id)
        current.set(id, value)
        opened.set(value.done, value)
        if (previous) {
          previous.current = false
          yield* retire(previous)
        }
        // Closed handles retain only completion, not retired capability functions or layers.
        const done = value.done
        return () =>
          Effect.gen(function* () {
            yield* Effect.uninterruptible(
              Effect.gen(function* () {
                const value = opened.get(done)
                if (!value) return
                if (current.get(id) === value) current.delete(id)
                value.current = false
                yield* retire(value)
              }),
            )
            yield* Deferred.await(done)
          })
      }),
      resolve: (session) =>
        Effect.gen(function* () {
          const value = current.get(session.id)
          if (!value) return { status: owned.has(session.id) ? ("owned-detached" as const) : ("unowned" as const) }
          yield* Effect.acquireRelease(
            Effect.sync(() => {
              value.users++
            }),
            () => release(value),
          )
          return { status: "attached" as const, capabilities: value.capabilities }
        }),
      pin: (id) => {
        const value = current.get(id)
        if (!value) return
        value.users++
        pinned.set(id, value)
      },
      pinned: (id) => pinned.get(id)?.runner,
      settle: (id) =>
        Effect.suspend(() => {
          const value = pinned.get(id)
          if (!value) return Effect.void
          pinned.delete(id)
          return release(value)
        }),
      remove: (id) =>
        Effect.gen(function* () {
          const value = current.get(id)
          current.delete(id)
          if (value) {
            value.current = false
            yield* retire(value)
          }
          if (!owned.has(id)) return
          yield* kv.remove(prefix + id)
          owned.delete(id)
        }),
    })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [
    KV.node,
    Database.node,
    Bus.node,
    SessionStore.node,
    llmClient,
    FSUtil.node,
    Global.node,
    webSocketConstructor,
    // Request preparation reads this Reference from the captured globals, not its fallback metadata.
    App.node,
  ],
})

/** TODO: replace this defect with the typed error in the capability-gated operations phase. */
export const unavailable = (sessionID: SessionSchema.ID) =>
  Effect.die(new Error(`Session must be reopened with capabilities: ${sessionID}`))
