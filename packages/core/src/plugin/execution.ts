export * as PluginExecution from "./execution.js"

import { Context, Effect, Latch, Layer, Semaphore } from "effect"
import { makeLocationNode } from "@opencode-ai/util/effect/app-node"

export interface Interface {
  readonly lease: <A, E, R>(
    session: { readonly id: string; readonly parentID?: string; readonly admission?: boolean },
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>
  readonly exclusive: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/PluginExecution") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const admission = yield* Latch.make(true)
    const idle = yield* Latch.make(true)
    const mutations = yield* Semaphore.make(1)
    const readers = new Map<string, number>()
    let leases = 0

    const acquire = (session: {
      readonly id: string
      readonly parentID?: string
      readonly admission?: boolean
    }): Effect.Effect<void> =>
      Effect.suspend(() => {
        // Child execution must finish the parent's tool call even while activation waits.
        if (
          !admission.isOpen() &&
          !readers.has(session.id) &&
          !(session.parentID && readers.has(session.parentID)) &&
          !(session.admission && leases > 0)
        )
          return Effect.interruptible(admission.await).pipe(Effect.andThen(acquire(session)))
        // Admission protects callbacks but does not establish Session execution ownership.
        if (!session.admission) readers.set(session.id, (readers.get(session.id) ?? 0) + 1)
        leases++
        return idle.close
      })

    return Service.of({
      lease: (session, effect) =>
        Effect.acquireUseRelease(
          acquire(session),
          () => effect,
          () =>
            Effect.suspend(() => {
              leases--
              if (!session.admission) {
                const count = (readers.get(session.id) ?? 1) - 1
                if (count === 0) readers.delete(session.id)
                else readers.set(session.id, count)
              }
              return leases === 0 ? idle.open : Effect.void
            }),
        ),
      exclusive: (effect) =>
        mutations.withPermit(
          Effect.uninterruptibleMask((restore) =>
            admission.close.pipe(
              Effect.andThen(restore(idle.await).pipe(Effect.andThen(restore(effect)))),
              Effect.ensuring(admission.open),
            ),
          ),
        ),
    })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [] })
