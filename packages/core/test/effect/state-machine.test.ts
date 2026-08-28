import { describe, expect } from "bun:test"
import { Cause, Deferred, Effect, Exit, Fiber, Option, Ref, Scheduler } from "effect"
import { StateMachine } from "@opencode-ai/core/effect/state-machine"
import { it } from "../lib/effect"

describe("StateMachine", () => {
  it.effect("runs invoked operations through pure transitions", () => {
    type Event = { readonly _tag: "Completed"; readonly value: number }
    type Operation = { readonly _tag: "Work" }
    const definition = StateMachine.define<"running", Event, Operation, never, number>({
      initial: StateMachine.next("running", StateMachine.invoke("work", { _tag: "Work" })),
      transition: (state, event) => {
        expect(state).toBe("running")
        expect(event._tag).toBe("InvocationExited")
        if (event._tag !== "InvocationExited" || Exit.isFailure(event.exit)) return StateMachine.done(-1)
        return StateMachine.done(event.exit.value.value)
      },
    })
    return StateMachine.run(definition, () => Effect.succeed({ _tag: "Completed", value: 42 })).pipe(
      Effect.map((output) => expect(output).toBe(42)),
    )
  })

  it.effect("preserves the operation Cause", () => {
    type Operation = { readonly _tag: "Work" }
    const definition = StateMachine.define<"running", never, Operation, string, Cause.Cause<string>>({
      initial: StateMachine.next("running", StateMachine.invoke("work", { _tag: "Work" })),
      transition: (_, event) => {
        if (event._tag === "InvocationExited" && Exit.isFailure(event.exit)) return StateMachine.done(event.exit.cause)
        throw new Error("Expected the invocation to fail")
      },
    })
    return StateMachine.run(definition, () => Effect.fail("boom")).pipe(
      Effect.map((cause) => {
        expect(Option.getOrUndefined(Cause.findErrorOption(cause))).toBe("boom")
      }),
    )
  })

  it.effect("settles owned work before propagating interruption", () =>
    Effect.gen(function* () {
      const finalized = yield* Deferred.make<void>()
      type State = "running" | "stopping"
      type Event = { readonly _tag: "Cancel" }
      type Operation = { readonly _tag: "Work" }
      const definition = StateMachine.define<State, Event, Operation, never, "cancelled">({
        initial: StateMachine.next("running", StateMachine.invoke("work", { _tag: "Work" })),
        interruption: { _tag: "Cancel" } as const,
        transition: (state, event) => {
          if (event._tag === "Input") {
            expect(state).toBe("running")
            return StateMachine.next("stopping" as const, StateMachine.stop("work"))
          }
          expect(state).toBe("stopping")
          if (event._tag !== "InvocationExited") throw new Error("Expected the invocation to stop")
          expect(Exit.hasInterrupts(event.exit)).toBe(true)
          return StateMachine.done("cancelled" as const)
        },
      })
      const machine = yield* StateMachine.run(definition, () =>
        Effect.never.pipe(Effect.ensuring(Deferred.succeed(finalized, undefined))),
      ).pipe(Effect.forkChild({ startImmediately: true }))

      yield* Effect.yieldNow
      yield* Fiber.interrupt(machine)
      const exit = yield* Fiber.await(machine)
      expect(Exit.hasInterrupts(exit)).toBe(true)
      expect(yield* Deferred.isDone(finalized)).toBe(true)
    }),
  )

  it.effect("runs cleanup invocations after interruption", () =>
    Effect.gen(function* () {
      const workStarted = yield* Deferred.make<void>()
      const cleanupRan = yield* Deferred.make<void>()
      type State = "running" | "stopping" | "cleaning"
      type Event = { readonly _tag: "Cancel" } | { readonly _tag: "WorkDone" } | { readonly _tag: "CleanupDone" }
      type Operation = { readonly _tag: "Work" } | { readonly _tag: "Cleanup" }
      const definition = StateMachine.define<State, Event, Operation, never, void>({
        initial: StateMachine.next("running", StateMachine.invoke("phase", { _tag: "Work" })),
        interruption: { _tag: "Cancel" },
        transition: (state, event) => {
          if (event._tag === "Input")
            return StateMachine.next("stopping", StateMachine.stopAndJoin("interruption", ["phase"]))
          if (state === "stopping") {
            if (event._tag !== "InvocationsStopped") throw new Error("Expected the aggregate stop result")
            expect(event.id).toBe("interruption")
            expect(event.exits).toMatchObject([{ id: "phase", operation: { _tag: "Work" } }])
            expect(Exit.hasInterrupts(event.exits[0].exit)).toBe(true)
            return StateMachine.next("cleaning", StateMachine.invoke("cleanup", { _tag: "Cleanup" }))
          }
          if (state === "cleaning") return StateMachine.done(undefined)
          throw new Error("Unexpected state machine transition")
        },
      })
      const machine = yield* StateMachine.run(definition, (operation) => {
        if (operation._tag === "Cleanup")
          return Deferred.succeed(cleanupRan, undefined).pipe(Effect.as({ _tag: "CleanupDone" } as const))
        return Deferred.succeed(workStarted, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.as({ _tag: "WorkDone" } as const),
        )
      }).pipe(Effect.forkChild({ startImmediately: true }))

      yield* Deferred.await(workStarted)
      yield* Fiber.interrupt(machine)
      expect(Exit.hasInterrupts(yield* Fiber.await(machine))).toBe(true)
      expect(yield* Deferred.isDone(cleanupRan)).toBe(true)
    }),
  )

  it.effect("stops invocations together and joins cross-dependent finalizers", () =>
    Effect.gen(function* () {
      const started = { left: yield* Deferred.make<void>(), right: yield* Deferred.make<void>() }
      const finalizing = { left: yield* Deferred.make<void>(), right: yield* Deferred.make<void>() }
      const finalized = yield* Ref.make<ReadonlyArray<string>>([])
      type State = "running" | "stopping" | "verifying"
      type Event = "ready" | "verified"
      type Operation = "left" | "right" | "trigger" | "verify"
      const definition = StateMachine.define<State, Event, Operation, never, boolean>({
        initial: StateMachine.next(
          "running",
          StateMachine.invoke<Operation>("left", "left"),
          StateMachine.invoke<Operation>("right", "right"),
          StateMachine.invoke<Operation>("trigger", "trigger"),
        ),
        transition: (state, event) => {
          if (event._tag === "InvocationExited" && event.operation === "trigger")
            return StateMachine.next("stopping", StateMachine.stopAndJoin("workers", ["left", "right"]))
          if (event._tag === "InvocationsStopped") {
            expect(state).toBe("stopping")
            expect(event.id).toBe("workers")
            expect(event.exits).toMatchObject([
              { _tag: "InvocationExited", id: "left", generation: 1, operation: "left" },
              { _tag: "InvocationExited", id: "right", generation: 2, operation: "right" },
            ])
            expect(event.exits.every((invocation) => Exit.hasInterrupts(invocation.exit))).toBe(true)
            return StateMachine.next("verifying", StateMachine.invoke("verify", "verify"))
          }
          if (event._tag === "InvocationExited" && event.operation === "verify") {
            expect(state).toBe("verifying")
            expect(event.exit).toEqual(Exit.succeed("verified"))
            return StateMachine.done(true)
          }
          throw new Error("Unexpected state machine transition")
        },
      })
      const output = yield* StateMachine.run(definition, (operation) => {
        if (operation === "trigger")
          return Deferred.await(started.left).pipe(Effect.andThen(Deferred.await(started.right)), Effect.as("ready"))
        if (operation === "verify")
          return Ref.get(finalized).pipe(
            Effect.map((value) => {
              expect(value.toSorted()).toEqual(["left", "right"])
              return "verified" as const
            }),
          )
        return Deferred.succeed(started[operation], undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(
            Deferred.succeed(finalizing[operation], undefined).pipe(
              Effect.andThen(Deferred.await(finalizing[operation === "left" ? "right" : "left"])),
              Effect.andThen(Ref.update(finalized, (value) => [...value, operation])),
            ),
          ),
        )
      })
      expect(output).toBe(true)
    }),
  )

  it.effect("aggregates queued and never-started exits once without affecting reused keys", () =>
    Effect.gen(function* () {
      const completed = yield* Deferred.make<Fiber.Fiber<unknown, unknown>>()
      const releaseCompleted = yield* Deferred.make<void>()
      const gateStarted = yield* Deferred.make<void>()
      const childStarted = yield* Deferred.make<void>()
      type Event = "completed" | "triggered" | "replaced"
      type Operation = "complete" | "gate" | "trigger" | "never-started" | "replacement"
      type Seen = ReadonlyArray<StateMachine.RuntimeEvent<Event, Operation, never>>
      const definition = StateMachine.define<Seen, Event, Operation, never, Seen>({
        initial: StateMachine.next(
          [],
          StateMachine.invoke<Operation>("completed", "complete"),
          StateMachine.invoke<Operation>("gate", "gate"),
          StateMachine.invoke<Operation>("trigger", "trigger"),
        ),
        transition: (state, event) => {
          const seen = [...state, event]
          if (event._tag === "InvocationExited" && event.operation === "trigger")
            return StateMachine.next(
              seen,
              StateMachine.stop("gate"),
              StateMachine.invoke<Operation>("child", "never-started"),
              StateMachine.stopAndJoin("batch", ["completed", "gate", "child"]),
              StateMachine.invoke<Operation>("completed", "replacement"),
              StateMachine.invoke<Operation>("child", "replacement"),
            )
          return seen.length === 4 ? StateMachine.done(seen) : StateMachine.next(seen)
        },
      })
      const seen = yield* StateMachine.run(definition, (operation) => {
        if (operation === "complete")
          return Effect.withFiber((fiber) => Deferred.succeed(completed, fiber)).pipe(
            Effect.andThen(Deferred.await(releaseCompleted)),
            Effect.as("completed"),
          )
        if (operation === "gate")
          return Deferred.succeed(gateStarted, undefined).pipe(
            Effect.andThen(Effect.never),
            // Hold the command loop until the completed child's exit is queued.
            Effect.ensuring(
              Deferred.succeed(releaseCompleted, undefined).pipe(
                Effect.andThen(Deferred.await(completed)),
                Effect.flatMap(Fiber.await),
              ),
            ),
          )
        if (operation === "trigger")
          return Deferred.await(completed).pipe(Effect.andThen(Deferred.await(gateStarted)), Effect.as("triggered"))
        if (operation === "never-started")
          return Deferred.succeed(childStarted, undefined).pipe(Effect.andThen(Effect.never))
        return Effect.succeed("replaced")
      }).pipe(
        // Keep the adjacent invoke/stop commands in one scheduler slice.
        Effect.provideService(Scheduler.PreventSchedulerYield, true),
      )

      expect(seen.map((event) => (event._tag === "InvocationExited" ? event.operation : event._tag))).toEqual([
        "trigger",
        "InvocationsStopped",
        "replacement",
        "replacement",
      ])
      const stopped = seen[1]
      if (stopped._tag !== "InvocationsStopped") throw new Error("Expected the aggregate stop result")
      expect(stopped.id).toBe("batch")
      expect(stopped.exits).toMatchObject([
        {
          _tag: "InvocationExited",
          id: "completed",
          generation: 1,
          operation: "complete",
          exit: Exit.succeed("completed"),
        },
        { _tag: "InvocationExited", id: "gate", generation: 2, operation: "gate" },
        { _tag: "InvocationExited", id: "child", generation: 4, operation: "never-started" },
      ])
      expect(stopped.exits.slice(1).every((invocation) => Exit.hasInterrupts(invocation.exit))).toBe(true)
      expect(seen.slice(2)).toMatchObject([
        { _tag: "InvocationExited", id: "completed", generation: 5, exit: Exit.succeed("replaced") },
        { _tag: "InvocationExited", id: "child", generation: 6, exit: Exit.succeed("replaced") },
      ])
      expect(yield* Deferred.isDone(childStarted)).toBe(false)
    }),
  )

  it.effect("emits an empty aggregate for an empty stop batch", () => {
    const definition = StateMachine.define<"stopping", never, never, never, boolean>({
      initial: StateMachine.next("stopping", StateMachine.stopAndJoin("empty", [])),
      transition: (_, event) => {
        expect(event).toEqual({ _tag: "InvocationsStopped", id: "empty", exits: [] })
        return StateMachine.done(true)
      },
    })
    return StateMachine.run(definition, () => Effect.die("Unexpected operation")).pipe(
      Effect.map((output) => expect(output).toBe(true)),
    )
  })

  it.effect("awaits a never-started finalizer without interrupting it", () =>
    Effect.gen(function* () {
      const finalized = yield* Ref.make(0)
      type Operation = "work" | "finalize"
      const definition = StateMachine.define<"stopping", "finalized", Operation, never, boolean>({
        initial: StateMachine.next(
          "stopping",
          StateMachine.invoke<Operation>("work", "work"),
          StateMachine.invoke<Operation>("finalizer", "finalize"),
          StateMachine.stopAndJoin("batch", ["work"], ["finalizer"]),
        ),
        transition: (_, event) => {
          if (event._tag !== "InvocationsStopped") throw new Error("Expected only the joined batch")
          expect(event.exits).toHaveLength(2)
          expect(event.exits[0].id).toBe("work")
          expect(Exit.hasInterrupts(event.exits[0].exit)).toBe(true)
          expect(event.exits[1]).toMatchObject({ id: "finalizer", exit: Exit.succeed("finalized") })
          return StateMachine.done(true)
        },
      })
      expect(
        yield* StateMachine.run(definition, (operation) =>
          operation === "work"
            ? Effect.never
            : Ref.update(finalized, (count) => count + 1).pipe(Effect.as("finalized" as const)),
        ).pipe(Effect.provideService(Scheduler.PreventSchedulerYield, true)),
      ).toBe(true)
      expect(yield* Ref.get(finalized)).toBe(1)
    }),
  )

  it.effect("defects when a stop batch contains an unknown invocation", () =>
    Effect.gen(function* () {
      const definition = StateMachine.define<"stopping", never, "work", never, never>({
        initial: StateMachine.next(
          "stopping",
          StateMachine.invoke("known", "work"),
          StateMachine.stopAndJoin("batch", ["known", "unknown"]),
        ),
        transition: () => {
          throw new Error("Unexpected state machine transition")
        },
      })
      const exit = yield* StateMachine.run(definition, () => Effect.never).pipe(Effect.exit)
      if (Exit.isSuccess(exit)) throw new Error("Expected an unknown invocation defect")
      expect(Cause.hasDies(exit.cause)).toBe(true)
      expect(Cause.prettyErrors(exit.cause).map((error) => error.message)).toEqual([
        "Unknown state machine invocation in StopAndJoin",
      ])
    }),
  )

  it.effect("observes an individual exit when a deferred child is stopped before starting", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const definition = StateMachine.define<"stopping", never, "work", never, boolean>({
        initial: StateMachine.next("stopping", StateMachine.invoke("work", "work"), StateMachine.stop("work")),
        transition: (_, event) => {
          if (event._tag !== "InvocationExited") throw new Error("Expected the invocation to stop")
          expect(event.id).toBe("work")
          expect(Exit.hasInterrupts(event.exit)).toBe(true)
          return StateMachine.done(true)
        },
      })
      const output = yield* StateMachine.run(definition, () =>
        Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
      ).pipe(Effect.provideService(Scheduler.PreventSchedulerYield, true))
      expect(output).toBe(true)
      expect(yield* Deferred.isDone(started)).toBe(false)
    }),
  )

  it.effect("waits for replaced invocation cleanup and ignores its stale exit", () =>
    Effect.gen(function* () {
      const firstStarted = yield* Deferred.make<void>()
      const releaseTrigger = yield* Deferred.make<void>()
      const events = yield* Ref.make<ReadonlyArray<string>>([])
      type State = "first" | "second"
      type Event = { readonly _tag: "Triggered" } | { readonly _tag: "SecondDone" }
      type Operation = { readonly _tag: "First" } | { readonly _tag: "Trigger" } | { readonly _tag: "Second" }
      const definition = StateMachine.define<State, Event, Operation, never, string>({
        initial: StateMachine.next(
          "first",
          StateMachine.invoke<Operation>("work", { _tag: "First" }),
          StateMachine.invoke<Operation>("trigger", { _tag: "Trigger" }),
        ),
        transition: (state, event) => {
          if (event._tag !== "InvocationExited" || Exit.isFailure(event.exit)) return StateMachine.done("unexpected")
          if (event.operation._tag === "Trigger") {
            return StateMachine.next("second" as const, StateMachine.invoke("work", { _tag: "Second" } as const))
          }
          if (state === "second") return StateMachine.done(event.exit.value._tag)
          return StateMachine.next(state)
        },
      })
      const output = yield* StateMachine.run(definition, (operation) => {
        if (operation._tag === "Trigger")
          return Deferred.await(releaseTrigger).pipe(Effect.as({ _tag: "Triggered" } as const))
        if (operation._tag === "Second") {
          return Ref.update(events, (value) => [...value, "second started"]).pipe(
            Effect.as({ _tag: "SecondDone" } as const),
          )
        }
        return Deferred.succeed(firstStarted, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(Ref.update(events, (value) => [...value, "first finalized"])),
        )
      }).pipe(Effect.forkChild({ startImmediately: true }))

      yield* Deferred.await(firstStarted)
      yield* Deferred.succeed(releaseTrigger, undefined)
      expect(yield* Fiber.join(output)).toBe("SecondDone")
      expect(yield* Ref.get(events)).toEqual(["first finalized", "second started"])
    }),
  )

  it.effect("does not start the next invocation when interruption is pending at the transition boundary", () =>
    Effect.gen(function* () {
      const releaseFirst = yield* Deferred.make<void>()
      const secondStarted = yield* Deferred.make<void>()
      type State = "first" | "second"
      type Event = { readonly _tag: "FirstDone" } | { readonly _tag: "SecondDone" }
      type Operation = { readonly _tag: "First" } | { readonly _tag: "Second" }
      let machine: Fiber.Fiber<string> | undefined
      const definition = StateMachine.define<State, Event, Operation, never, string>({
        initial: StateMachine.next("first", StateMachine.invoke("work", { _tag: "First" })),
        transition: (state, event) => {
          if (event._tag !== "InvocationExited" || Exit.isFailure(event.exit)) return StateMachine.done("unexpected")
          if (state === "second") return StateMachine.done("completed")
          machine?.interruptUnsafe(123)
          return StateMachine.next("second", StateMachine.invoke("work", { _tag: "Second" }))
        },
      })
      machine = yield* StateMachine.run(definition, (operation) =>
        operation._tag === "First"
          ? Deferred.await(releaseFirst).pipe(Effect.as({ _tag: "FirstDone" } as const))
          : Deferred.succeed(secondStarted, undefined).pipe(Effect.as({ _tag: "SecondDone" } as const)),
      ).pipe(Effect.forkChild({ startImmediately: true }))

      yield* Deferred.succeed(releaseFirst, undefined)
      expect(Exit.hasInterrupts(yield* Fiber.await(machine))).toBe(true)
      expect(yield* Deferred.isDone(secondStarted)).toBe(false)
    }),
  )
})
