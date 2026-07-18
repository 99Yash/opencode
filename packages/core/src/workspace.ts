export * as WorkspaceV2 from "./workspace"

import { Context, Effect, Equal, Exit, Latch, Layer, RcMap, Schema, Scope, Semaphore } from "effect"
import { Workspace } from "@opencode-ai/schema/workspace"
import { eq } from "drizzle-orm"
import { Database } from "./database/database"
import { makeGlobalNode } from "./effect/app-node"
import { AbsolutePath } from "./schema"
import { WorkspaceTable } from "./control-plane/workspace.sql"
import { Sandbox } from "./workspace/sandbox"
import type { WorkspaceEnvironment } from "./workspace/environment"

export const ID = Workspace.ID
export type ID = typeof ID.Type

export const Info = Workspace.Info
export type Info = Workspace.Info

export interface CreateInput {
  readonly provider: string
  readonly name: string
  readonly directory: AbsolutePath
  readonly projectID: Info["project"]["id"]
}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("Workspace.NotFoundError", {
  id: ID,
}) {}

export class InvalidError extends Schema.TaggedErrorClass<InvalidError>()("Workspace.InvalidError", {
  id: ID,
  message: Schema.String,
}) {}

export interface Interface {
  readonly create: (input: CreateInput) => Effect.Effect<Info, Sandbox.Error | Sandbox.ProviderNotFoundError>
  readonly get: (id: ID) => Effect.Effect<Info, NotFoundError | InvalidError>
  readonly connect: (
    id: ID,
  ) => Effect.Effect<void, NotFoundError | InvalidError | Sandbox.Error | Sandbox.ProviderNotFoundError>
  readonly borrow: (
    id: ID,
  ) => Effect.Effect<
    WorkspaceEnvironment.Interface,
    NotFoundError | InvalidError | Sandbox.Error | Sandbox.ProviderNotFoundError,
    Scope.Scope
  >
  readonly suspend: (
    id: ID,
  ) => Effect.Effect<void, NotFoundError | InvalidError | Sandbox.Error | Sandbox.ProviderNotFoundError>
  readonly remove: (
    id: ID,
  ) => Effect.Effect<void, NotFoundError | InvalidError | Sandbox.Error | Sandbox.ProviderNotFoundError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Workspace") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const registry = yield* Sandbox.RegistryService
    const lifecycle = yield* RcMap.make({
      idleTimeToLive: 0,
      lookup: () => Effect.succeed(makeLifecycleGate()),
    })

    const row = Effect.fn("Workspace.row")(function* (id: ID) {
      const value = yield* db.select().from(WorkspaceTable).where(eq(WorkspaceTable.id, id)).get().pipe(Effect.orDie)
      if (!value) return yield* new NotFoundError({ id })
      if (!value.directory) return yield* new InvalidError({ id, message: "Workspace has no directory" })
      return { ...value, directory: value.directory }
    })

    const get = Effect.fn("Workspace.get")(function* (id: ID) {
      const value = yield* row(id)
      const directory = AbsolutePath.make(value.directory)
      return Info.make({
        id,
        name: value.name,
        directory,
        project: { id: value.project_id, directory },
      })
    })

    const create = Effect.fn("Workspace.create")(function* (input: CreateInput) {
      const id = ID.create()
      const provider = yield* registry.get(input.provider)
      return yield* Effect.acquireUseRelease(
        provider.create({ identity: id }),
        (binding) =>
          db
            .insert(WorkspaceTable)
            .values({
              id,
              type: provider.key,
              name: input.name,
              directory: input.directory,
              extra: Sandbox.Placement.make({ kind: "sandbox", version: 1, binding }),
              project_id: input.projectID,
            })
            .run()
            .pipe(
              Effect.orDie,
              Effect.as(
                Info.make({
                  id,
                  name: input.name,
                  directory: input.directory,
                  project: { id: input.projectID, directory: input.directory },
                }),
              ),
            ),
        (binding, exit) => (Exit.isFailure(exit) ? Effect.uninterruptible(provider.delete(binding)) : Effect.void),
      )
    })

    const persistBinding = Effect.fnUntraced(function* (id: ID, previous: Sandbox.Binding, next: Sandbox.Binding) {
      if (Equal.equals(previous, next)) return
      yield* db
        .update(WorkspaceTable)
        .set({ extra: Sandbox.Placement.make({ kind: "sandbox", version: 1, binding: next }) })
        .where(eq(WorkspaceTable.id, id))
        .run()
        .pipe(Effect.orDie)
    })

    const placement = Effect.fnUntraced(function* (id: ID) {
      const value = yield* row(id)
      if (!Schema.is(Sandbox.Placement)(value.extra)) {
        return yield* new InvalidError({ id, message: "Workspace has no sandbox binding" })
      }
      const provider = yield* registry.get(value.type)
      return { provider, binding: yield* provider.decode(value.extra.binding) }
    })

    const reconcile = Effect.fnUntraced(function* (id: ID, provider: Sandbox.Provider, binding: Sandbox.Binding) {
      const next = yield* provider.reconcile(binding)
      yield* persistBinding(id, binding, next)
      return next
    })

    const connections = yield* RcMap.make({
      idleTimeToLive: "1 minute",
      lookup: Effect.fn("Workspace.connect")(function* (id: ID) {
        const current = yield* placement(id)
        const provider = current.provider
        const binding = current.binding
        const connection = yield* provider.connect(binding)
        yield* persistBinding(id, binding, connection.binding)
        yield* reconcile(id, provider, connection.binding)
        return { provider, connection }
      }),
    })

    const lease = (id: ID) => RcMap.get(lifecycle, id).pipe(Effect.flatMap((gate) => gate.read))

    const borrow = (id: ID) =>
      lease(id).pipe(
        Effect.andThen(RcMap.get(connections, id)),
        Effect.onExit((exit) => (Exit.isFailure(exit) ? RcMap.invalidate(connections, id) : Effect.void)),
        Effect.map((value) => value.connection.environment),
      )

    const transition = <A, E, R>(id: ID, effect: Effect.Effect<A, E, R>) =>
      Effect.scoped(RcMap.get(lifecycle, id).pipe(Effect.flatMap((gate) => gate.write(effect))))

    const suspend = Effect.fn("Workspace.suspend")((id: ID) =>
      transition(
        id,
        Effect.scoped(
          RcMap.get(connections, id).pipe(
            Effect.flatMap((value) =>
              Effect.gen(function* () {
                const binding = yield* Effect.uninterruptible(
                  value.provider
                    .suspend(value.connection)
                    .pipe(Effect.tap((binding) => persistBinding(id, value.connection.binding, binding))),
                )
                yield* reconcile(id, value.provider, binding)
              }),
            ),
          ),
        ).pipe(Effect.ensuring(RcMap.invalidate(connections, id))),
      ),
    )

    const remove = Effect.fn("Workspace.remove")((id: ID) =>
      transition(
        id,
        Effect.gen(function* () {
          yield* RcMap.invalidate(connections, id)
          const current = yield* placement(id)
          const binding = yield* reconcile(id, current.provider, current.binding)
          yield* Effect.uninterruptible(
            current.provider
              .delete(binding)
              .pipe(
                Effect.andThen(db.delete(WorkspaceTable).where(eq(WorkspaceTable.id, id)).run().pipe(Effect.orDie)),
              ),
          )
        }),
      ),
    )

    return Service.of({
      create,
      get,
      connect: (id) => Effect.scoped(borrow(id)).pipe(Effect.asVoid),
      borrow,
      suspend,
      remove,
    })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Database.node, Sandbox.registryNode],
})

function makeLifecycleGate() {
  const admission = Semaphore.makeUnsafe(1)
  const transition = Semaphore.makeUnsafe(1)
  const open = Latch.makeUnsafe(true)
  const drained = Latch.makeUnsafe(true)
  let active = 0
  let blocked = false

  const read: Effect.Effect<void, never, Scope.Scope> = Effect.suspend(() =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        yield* restore(open.await)
        yield* restore(admission.take(1))
        if (blocked) {
          yield* admission.release(1)
          return yield* restore(read)
        }
        active++
        if (active === 1) drained.closeUnsafe()
        const scope = yield* Scope.Scope
        yield* Scope.addFinalizer(
          scope,
          Effect.sync(() => {
            active--
            if (active === 0) drained.openUnsafe()
          }),
        )
        yield* admission.release(1)
      }),
    ),
  )

  const write = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    transition.withPermit(
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          yield* restore(admission.take(1))
          blocked = true
          open.closeUnsafe()
          yield* admission.release(1)
          return yield* restore(drained.await.pipe(Effect.andThen(effect))).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                blocked = false
              }).pipe(Effect.andThen(open.open)),
            ),
          )
        }),
      ),
    )

  return { read, write }
}
