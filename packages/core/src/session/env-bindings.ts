export * as SessionEnvBindings from "./env-bindings.js"

import { Context, Effect, Layer, Scope } from "effect"
import { makeGlobalNode } from "@opencode-ai/util/effect/app-node"
import type { SessionEnv } from "../location-services.js"
import { SessionSchema } from "./schema.js"

/**
 * Process-local map from Session ID to a values-constructed engine graph.
 * Execution resolves a bound context before falling back to the Session's
 * Location graph, so tier-2 sessions drain against caller-supplied
 * capabilities while every other session is untouched.
 */
export interface Interface {
  /** Bind until the enclosing scope closes. Rebinding the same ID replaces the previous binding. */
  readonly bind: (
    id: SessionSchema.ID,
    context: Context.Context<SessionEnv>,
  ) => Effect.Effect<void, never, Scope.Scope>
  readonly get: (id: SessionSchema.ID) => Context.Context<SessionEnv> | undefined
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionEnvBindings") {}

export const layer = Layer.sync(Service, () => {
  const map = new Map<SessionSchema.ID, Context.Context<SessionEnv>>()
  return Service.of({
    bind: (id, context) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          map.set(id, context)
        }),
        () =>
          Effect.sync(() => {
            // A later rebind owns the entry now; do not tear it down.
            if (map.get(id) === context) map.delete(id)
          }),
      ),
    get: (id) => map.get(id),
  })
})

export const node = makeGlobalNode({ service: Service, layer, deps: [] })
