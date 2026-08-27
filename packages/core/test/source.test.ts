import { expect } from "bun:test"
import { Effect } from "effect"
import { Source } from "../src/source"
import { session } from "./fixture/capabilities"
import { it } from "./lib/effect"

it.effect("mutable sources sample current values and defer writes until execution", () =>
  Effect.gen(function* () {
    const source = Source.mutable(1)
    const independent = Source.mutable(1)
    const read = source.get(session)
    const set = source.set(2)
    const update = source.update((value) => value + 3)

    expect(yield* read).toBe(1)
    yield* set
    expect(yield* read).toBe(2)
    yield* update
    expect(yield* read).toBe(5)
    expect(yield* independent.get(session)).toBe(1)
  }),
)

it.effect("constant and plain values retain their identity", () =>
  Effect.gen(function* () {
    const values = ["read", "write"]
    expect(yield* Source.constant(values).get(session)).toBe(values)
    expect(yield* Source.from(values).get(session)).toBe(values)
    expect(yield* Source.from(null).get(session)).toBeNull()
    expect(yield* Source.from(undefined).get(session)).toBeUndefined()
    expect(yield* Source.from(0).get(session)).toBe(0)
    const record = { get: "not a source" }
    expect(yield* Source.from(record).get(session)).toBe(record)
  }),
)

it.effect("structural sources receive the session and preserve typed failures", () =>
  Effect.gen(function* () {
    const source: Source.Interface<string, "unavailable"> = {
      get: (current) => (current.title === "unavailable" ? Effect.fail("unavailable") : Effect.succeed(current.id)),
    }
    const converted: Source.Interface<string, "unavailable"> = Source.from(source)
    expect(converted).toBe(source)
    expect(yield* converted.get(session)).toBe(session.id)
    expect(yield* converted.get({ ...session, title: "unavailable" }).pipe(Effect.flip)).toBe("unavailable")
  }),
)
