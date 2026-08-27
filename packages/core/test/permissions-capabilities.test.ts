import { expect } from "bun:test"
import { Effect, Schema } from "effect"
import { Permission } from "../src/permission"
import { Permissions } from "../src/permissions"
import { SessionSchema } from "../src/session/schema"
import { Source } from "../src/source"
import { it } from "./lib/effect"

const session = Schema.decodeUnknownSync(SessionSchema.Info)({
  id: "ses_permissions",
  projectID: "global",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 0, updated: 0 },
  location: { directory: "/project" },
})

it.effect("allowAll permits requests and exposes an allow-all visibility rule", () =>
  Effect.gen(function* () {
    expect(yield* Permissions.allowAll.visibility.get(session)).toEqual([
      { action: "*", resource: "*", effect: "allow" },
    ])
    yield* Permissions.allowAll.ask(session, { action: "write", resources: ["src/file.ts", "other/file.ts"] })
  }),
)

it.effect("rules fail immediately for unmatched, ask, and denied resources", () =>
  Effect.gen(function* () {
    const request = { action: "read", resources: ["src/file.ts"] }
    yield* Effect.forEach(
      [
        [],
        [{ action: "read", resource: "*", effect: "ask" }],
        [{ action: "read", resource: "*", effect: "deny" }],
      ] satisfies Permission.Ruleset[],
      (rules) =>
        Effect.gen(function* () {
          const permissions = Permissions.rules(rules)
          expect(yield* permissions.visibility.get(session)).toBe(rules)
          expect(yield* permissions.ask(session, request).pipe(Effect.flip)).toEqual(
            new Permission.BlockedError({ rules, permission: request.action, resources: request.resources }),
          )
        }),
    )
  }),
)

it.effect("rules use wildcard precedence and require every resource to be allowed", () =>
  Effect.gen(function* () {
    const permissions = Permissions.rules([
      { action: "*", resource: "*", effect: "deny" },
      { action: "re*", resource: "src/*", effect: "allow" },
      { action: "read", resource: "src/private/*", effect: "ask" },
      { action: "read", resource: "src/private/public.ts", effect: "allow" },
    ])
    yield* permissions.ask(session, { action: "read", resources: ["src/file.ts", "src/private/public.ts"] })
    expect(
      yield* permissions
        .ask(session, { action: "read", resources: ["src/file.ts", "src/private/file.ts"] })
        .pipe(Effect.flip),
    ).toBeInstanceOf(Permission.BlockedError)
    expect(
      yield* permissions.ask(session, { action: "write", resources: ["src/file.ts"] }).pipe(Effect.flip),
    ).toBeInstanceOf(Permission.BlockedError)
  }),
)

it.effect("rules sample mutable and session-dependent sources for visibility and each request", () =>
  Effect.gen(function* () {
    const source = Source.mutable<Permission.Ruleset>([])
    const permissions = Permissions.rules(source)
    const request = { action: "read", resources: ["src/file.ts"] }
    expect(permissions.visibility).toBe(source)
    expect(yield* permissions.ask(session, request).pipe(Effect.flip)).toBeInstanceOf(Permission.BlockedError)
    yield* source.set([{ action: "read", resource: "*", effect: "allow" }])
    yield* permissions.ask(session, request)
    yield* source.update((rules) => [...rules, { action: "read", resource: "src/*", effect: "deny" }])
    expect(yield* permissions.ask(session, request).pipe(Effect.flip)).toBeInstanceOf(Permission.BlockedError)

    const scoped = Permissions.rules({
      get: (current) =>
        Effect.succeed([{ action: "read", resource: "*", effect: current.id === session.id ? "allow" : "deny" }]),
    })
    yield* scoped.ask(session, request)
    const other = { ...session, id: SessionSchema.ID.make("ses_other") }
    expect(yield* scoped.visibility.get(other)).toEqual([{ action: "read", resource: "*", effect: "deny" }])
    expect(yield* scoped.ask(other, request).pipe(Effect.flip)).toBeInstanceOf(Permission.BlockedError)
  }),
)
