export * as Permissions from "./permissions.js"

import { Effect } from "effect"
import { Permission } from "./permission.js"
import type { SessionSchema } from "./session/schema.js"
import { Source } from "./source.js"

export interface Interface {
  readonly visibility: Source.Interface<Permission.Ruleset>
  readonly ask: (
    session: SessionSchema.Info,
    request: Omit<Permission.AssertInput, "sessionID" | "agent">,
  ) => Effect.Effect<void, Permission.Error | Permission.DeclinedError>
}

export const allowAll: Interface = {
  visibility: Source.constant([{ action: "*", resource: "*", effect: "allow" }]),
  ask: () => Effect.void,
}

export function rules(source: Source.Value<Permission.Ruleset>): Interface {
  const visibility = Source.from(source)
  return {
    visibility,
    ask: Effect.fn("Permissions.ask")(function* (session, request) {
      const rules = yield* visibility.get(session)
      if (
        request.resources.every((resource) => Permission.evaluate(request.action, resource, rules).effect === "allow")
      )
        return
      return yield* new Permission.BlockedError({
        rules: Permission.relevant(request, rules),
        permission: request.action,
        resources: request.resources,
      })
    }),
  }
}
