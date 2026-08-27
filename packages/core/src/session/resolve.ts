export * as SessionResolve from "./resolve.js"

import type { LLMClientService } from "@opencode-ai/ai"
import { FSUtil } from "@opencode-ai/util/fs-util"
import { Global } from "@opencode-ai/util/global"
import { makeGlobalNode } from "@opencode-ai/util/effect/app-node"
import { Context, Effect, Exit, Layer, Scope } from "effect"
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

const prefix = "session.capabilities/"

type Opened = {
  readonly capabilities: SessionCapabilities.Capabilities
  readonly runner: SessionRunner.Interface
  readonly scope: Scope.Closeable
  readonly retire: () => Effect.Effect<void>
  current: boolean
  users: number
}

export interface Interface {
  readonly own: (id: SessionSchema.ID) => Effect.Effect<void>
  readonly owned: (id: SessionSchema.ID) => Effect.Effect<boolean>
  readonly ownedIDs: Effect.Effect<ReadonlyArray<SessionSchema.ID>>
  readonly available: (id: SessionSchema.ID) => Effect.Effect<boolean>
  readonly attach: (id: SessionSchema.ID, input: SessionCapabilities.OpenInput) => Effect.Effect<void>
  readonly resolve: (
    session: SessionSchema.Info,
  ) => Effect.Effect<SessionCapabilities.Capabilities | undefined, never, Scope.Scope>
  readonly pin: (id: SessionSchema.ID) => Effect.Effect<void>
  readonly pinned: (id: SessionSchema.ID) => SessionRunner.Interface | undefined
  readonly settle: (id: SessionSchema.ID) => Effect.Effect<void>
  readonly remove: (id: SessionSchema.ID) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionResolve") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const kv = yield* KV.Service
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
    const opened = new Set<Opened>()
    const retire = (value: Opened) =>
      Effect.suspend(() => {
        if (value.current || value.users > 0 || !opened.delete(value)) return Effect.void
        return Scope.close(value.scope, Exit.void).pipe(Effect.andThen(value.retire()))
      })
    const release = (value: Opened) =>
      Effect.sync(() => {
        value.users--
      }).pipe(Effect.andThen(retire(value)))
    const owned = (id: SessionSchema.ID) => kv.get(prefix + id).pipe(Effect.map((value) => value === true))
    const ownedIDs = Effect.gen(function* () {
      const ids: SessionSchema.ID[] = []
      let after: string | undefined
      do {
        const page = yield* kv.scan({ prefix, after })
        ids.push(
          ...page.entries
            .filter((entry) => entry.value === true)
            .map((entry) => SessionSchema.ID.make(entry.key.slice(prefix.length))),
        )
        after = page.next
      } while (after !== undefined)
      return ids
    })
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => current.clear()).pipe(
        Effect.andThen(
          Effect.forEach(
            opened,
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
      own: (id) => kv.set(prefix + id, true),
      owned,
      ownedIDs,
      available: (id) =>
        Effect.suspend(() => (current.has(id) ? Effect.succeed(true) : owned(id).pipe(Effect.map((value) => !value)))),
      attach: Effect.fn("SessionResolve.attach")(function* (id, input) {
        const { Image } = yield* Effect.promise(() => import("../image.js"))
        const { PluginHooks } = yield* Effect.promise(() => import("../plugin/hooks.js"))
        const { PluginSupervisor } = yield* Effect.promise(() => import("../plugin/supervisor-service.js"))
        const { Snapshot } = yield* Effect.promise(() => import("../snapshot.js"))
        const { ToolOutput } = yield* Effect.promise(() => import("../tool-output.js"))
        const { SessionCompaction } = yield* Effect.promise(() => import("./compaction.js"))
        const { SessionContext } = yield* Effect.promise(() => import("./context.js"))
        const { InstructionEntry } = yield* Effect.promise(() => import("./instruction-entry.js"))
        const { SessionModelRequest } = yield* Effect.promise(() => import("./model-request.js"))
        const { SessionModelTransport } = yield* Effect.promise(() => import("./model-transport.js"))
        const { SessionRunner } = yield* Effect.promise(() => import("./runner/index.js"))
        const { SessionRunnerLLM } = yield* Effect.promise(() => import("./runner/llm.js"))
        const { SessionTitle } = yield* Effect.promise(() => import("./title.js"))
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
        const services = yield* Layer.buildWithScope(runner, scope).pipe(
          Effect.onError(() => Scope.close(scope, Exit.void)),
        )
        const value: Opened = {
          capabilities: {
            ...Context.get(services, SessionContext.Service),
            image: Context.get(services, Image.Service),
            compaction: Context.get(services, SessionCompaction.Service),
            snapshots: Context.get(services, Snapshot.Service),
            output: Context.get(services, ToolOutput.Service),
            transport: Context.get(services, SessionModelTransport.Service),
          },
          runner: Context.get(services, SessionRunner.Service),
          scope,
          retire: input.retire ?? (() => Effect.void),
          current: true,
          users: 0,
        }
        const previous = current.get(id)
        current.set(id, value)
        opened.add(value)
        if (!previous) return
        previous.current = false
        yield* retire(previous)
      }),
      resolve: (session) =>
        Effect.gen(function* () {
          const value = current.get(session.id)
          if (!value) {
            if (yield* owned(session.id))
              return yield* Effect.die(new Error(`Session must be reopened with capabilities: ${session.id}`))
            return
          }
          yield* Effect.acquireRelease(
            Effect.sync(() => {
              value.users++
            }),
            () => release(value),
          )
          return value.capabilities
        }),
      pin: (id) =>
        Effect.sync(() => {
          const value = current.get(id)
          if (!value) return
          value.users++
          pinned.set(id, value)
        }),
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
          yield* kv.remove(prefix + id)
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
    App.node,
  ],
})
