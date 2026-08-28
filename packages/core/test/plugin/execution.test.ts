import { expect } from "bun:test"
import { Effect, Fiber, Latch } from "effect"
import { PluginExecution } from "@opencode-ai/core/plugin/execution"
import { testEffect } from "../lib/effect"

const it = testEffect(PluginExecution.layer)

it.effect("defers activation through awaited children and titles, blocking unrelated selections", () =>
  Effect.gen(function* () {
    const gate = yield* PluginExecution.Service
    const childAllowed = yield* Latch.make()
    const titleFinished = yield* Latch.make()
    const events: string[] = []
    const parent = yield* gate
      .lease(
        { id: "parent" },
        Effect.gen(function* () {
          yield* childAllowed.await
          yield* gate.lease(
            { id: "child", parentID: "parent" },
            Effect.gen(function* () {
              yield* gate.lease(
                { id: "grandchild", parentID: "child" },
                Effect.sync(() => events.push("child")),
              )
            }),
          )
          yield* gate.lease(
            { id: "new-prompt", admission: true },
            Effect.sync(() => events.push("admitted")),
          )
          events.push("parent")
        }),
      )
      .pipe(Effect.forkScoped({ startImmediately: true }))
    const title = yield* gate
      .lease(
        { id: "parent", admission: true },
        titleFinished.await.pipe(Effect.andThen(Effect.sync(() => events.push("title")))),
      )
      .pipe(Effect.forkScoped({ startImmediately: true }))
    const activation = yield* gate
      .exclusive(Effect.sync(() => events.push("activation")))
      .pipe(Effect.forkScoped({ startImmediately: true }))
    const unrelated = yield* gate
      .lease(
        { id: "unrelated" },
        Effect.sync(() => events.push("selection")),
      )
      .pipe(Effect.forkScoped({ startImmediately: true }))
    expect(events).toEqual([])
    yield* childAllowed.open
    yield* Fiber.join(parent)
    expect(events).toEqual(["child", "admitted", "parent"])
    yield* titleFinished.open
    yield* Fiber.join(title)
    yield* Fiber.join(activation)
    yield* Fiber.join(unrelated)
    expect(events).toEqual(["child", "admitted", "parent", "title", "activation", "selection"])
  }),
)

it.effect("releases reader leases and pending admission on interruption", () =>
  Effect.gen(function* () {
    const gate = yield* PluginExecution.Service
    const reader = yield* gate.lease({ id: "reader" }, Effect.never).pipe(Effect.forkScoped({ startImmediately: true }))
    const writer = yield* gate.exclusive(Effect.never).pipe(Effect.forkScoped({ startImmediately: true }))
    const waiting = yield* gate
      .lease({ id: "waiting" }, Effect.never)
      .pipe(Effect.forkScoped({ startImmediately: true }))
    yield* Fiber.interrupt(waiting)
    yield* Fiber.interrupt(writer)
    expect(yield* gate.lease({ id: "new" }, Effect.succeed("open"))).toBe("open")
    yield* Fiber.interrupt(reader)
    expect(yield* gate.exclusive(Effect.succeed("idle"))).toBe("idle")
  }),
)

it.effect("does not let admission-only work establish same-Session or child execution ownership", () =>
  Effect.gen(function* () {
    const gate = yield* PluginExecution.Service
    const finishParent = yield* Latch.make()
    const finishAdmission = yield* Latch.make()
    const events: string[] = []
    const parent = yield* gate
      .lease({ id: "parent" }, finishParent.await)
      .pipe(Effect.forkScoped({ startImmediately: true }))
    const writer = yield* gate
      .exclusive(Effect.sync(() => events.push("activation")))
      .pipe(Effect.forkScoped({ startImmediately: true }))
    const admission = yield* gate
      .lease({ id: "unrelated", admission: true }, finishAdmission.await)
      .pipe(Effect.forkScoped({ startImmediately: true }))
    const unrelated = yield* gate
      .lease(
        { id: "unrelated" },
        Effect.sync(() => events.push("unrelated")),
      )
      .pipe(Effect.forkScoped({ startImmediately: true }))
    const child = yield* gate
      .lease(
        { id: "child", parentID: "unrelated" },
        Effect.sync(() => events.push("child")),
      )
      .pipe(Effect.forkScoped({ startImmediately: true }))
    expect(events).toEqual([])
    yield* finishParent.open
    yield* Fiber.join(parent)
    expect(events).toEqual([])
    yield* finishAdmission.open
    yield* Fiber.join(admission)
    yield* Fiber.join(writer)
    yield* Fiber.join(unrelated)
    yield* Fiber.join(child)
    expect(events[0]).toBe("activation")
    expect(events.slice(1).toSorted()).toEqual(["child", "unrelated"])
  }),
)

it.effect("a title-only helper protects its resources without allowing an idle Session or child to drain", () =>
  Effect.gen(function* () {
    const gate = yield* PluginExecution.Service
    const finishTitle = yield* Latch.make()
    const events: string[] = []
    const title = yield* gate
      .lease({ id: "idle", admission: true }, finishTitle.await)
      .pipe(Effect.forkScoped({ startImmediately: true }))
    const writer = yield* gate
      .exclusive(Effect.sync(() => events.push("activation")))
      .pipe(Effect.forkScoped({ startImmediately: true }))
    const session = yield* gate
      .lease(
        { id: "idle" },
        Effect.sync(() => events.push("session")),
      )
      .pipe(Effect.forkScoped({ startImmediately: true }))
    const child = yield* gate
      .lease(
        { id: "child", parentID: "idle" },
        Effect.sync(() => events.push("child")),
      )
      .pipe(Effect.forkScoped({ startImmediately: true }))
    expect(events).toEqual([])
    yield* finishTitle.open
    yield* Fiber.join(title)
    yield* Fiber.join(writer)
    yield* Fiber.join(session)
    yield* Fiber.join(child)
    expect(events[0]).toBe("activation")
    expect(events.slice(1).toSorted()).toEqual(["child", "session"])
  }),
)
