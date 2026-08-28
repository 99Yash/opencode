import { describe, expect, test } from "bun:test"
import { AIError, TransportError, type LLMEvent } from "@opencode-ai/ai"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionStep } from "@opencode-ai/core/session/runner/step"
import { SessionStepMachine } from "@opencode-ai/core/session/runner/step-machine"
import { Cause, Deferred, Effect, Exit, Fiber, Ref, Scheduler } from "effect"
import { it } from "./lib/effect"

const firstID = SessionMessage.ID.make("msg_first")
const failure = new AIError({
  reason: new TransportError({ message: "Provider unavailable", transport: "http", operation: "request" }),
})
const error = { type: "provider.transport", message: "Provider unavailable" } as const
describe("SessionStepMachine", () => {
  it.effect("completes a logical Step", () =>
    Effect.gen(function* () {
      const attempts = yield* Ref.make<ReadonlyArray<SessionStepMachine.Context>>([])
      const result = yield* SessionStepMachine.run(firstID, {
        prepare: (context) =>
          Ref.update(attempts, (values) => [...values, context]).pipe(
            Effect.as(
              SessionStepMachine.Preparation.Ready({
                attempt: makeAttempt(SessionStep.Outcome.Completed({ needsContinuation: true })),
              }),
            ),
          ),
        retry: () => Effect.void,
        publishSynthetic: Effect.void,
      })
      expect(result).toBe(true)
      expect(yield* Ref.get(attempts)).toEqual([
        { assistantMessageID: firstID, recoverOverflow: true, recoverContinuation: true },
      ])
    }),
  )

  it.effect("pulls, publishes, and runs a local tool before settlement", () =>
    Effect.gen(function* () {
      const operations = yield* Ref.make<ReadonlyArray<string>>([])
      const call = { type: "tool-call", id: "call_1", name: "lookup", input: {} } satisfies Extract<
        LLMEvent,
        { type: "tool-call" }
      >
      const attempt = makeAttempt(SessionStep.Outcome.Completed({ needsContinuation: false }), {
        events: [call],
        operations,
      })
      yield* SessionStepMachine.run(firstID, {
        prepare: () => Effect.succeed(SessionStepMachine.Preparation.Ready({ attempt })),
        retry: () => Effect.void,
        publishSynthetic: Effect.void,
      })
      const observed = yield* Ref.get(operations)
      expect(observed.indexOf("publish:tool-call")).toBeLessThan(observed.indexOf("tool:call_1"))
      expect(observed.at(-1)).toBe("settle")
    }),
  )

  it.effect("retries transparently with the same assistant", () =>
    Effect.gen(function* () {
      const outcomes: Array<SessionStep.Outcome> = [
        SessionStep.Outcome.Retry({ cause: failure, error }),
        SessionStep.Outcome.Completed({ needsContinuation: false }),
      ]
      const operations = yield* Ref.make<ReadonlyArray<string>>([])
      const result = yield* SessionStepMachine.run(firstID, {
        prepare: (context) =>
          Ref.update(operations, (values) => [...values, `attempt:${context.assistantMessageID}`]).pipe(
            Effect.map(() =>
              SessionStepMachine.Preparation.Ready({
                attempt: makeAttempt(outcomes.shift() ?? SessionStep.Outcome.Completed({ needsContinuation: false })),
              }),
            ),
          ),
        retry: (context) => Ref.update(operations, (values) => [...values, `retry:${context.assistantMessageID}`]),
        publishSynthetic: Effect.void,
      })
      expect(result).toBe(false)
      expect(yield* Ref.get(operations)).toEqual([`attempt:${firstID}`, `retry:${firstID}`, `attempt:${firstID}`])
    }),
  )

  it.effect("continues partial output only after retry and synthetic publication", () =>
    Effect.gen(function* () {
      const outcomes: Array<SessionStep.Outcome> = [
        SessionStep.Outcome.Continue({ cause: failure, error }),
        SessionStep.Outcome.Completed({ needsContinuation: false }),
      ]
      const operations = yield* Ref.make<ReadonlyArray<string>>([])
      yield* SessionStepMachine.run(firstID, {
        prepare: (context) =>
          Ref.update(operations, (values) => [...values, `attempt:${context.assistantMessageID}`]).pipe(
            Effect.map(() =>
              SessionStepMachine.Preparation.Ready({
                attempt: makeAttempt(outcomes.shift() ?? SessionStep.Outcome.Completed({ needsContinuation: false })),
              }),
            ),
          ),
        retry: () => Ref.update(operations, (values) => [...values, "retry"]),
        publishSynthetic: Ref.update(operations, (values) => [...values, "synthetic"]),
      })
      const observed = yield* Ref.get(operations)
      expect(observed.slice(0, 3)).toEqual([`attempt:${firstID}`, "retry", "synthetic"])
      expect(observed.at(3)).toStartWith("attempt:msg_")
      expect(observed.at(3)).not.toBe(`attempt:${firstID}`)
    }),
  )

  it.effect("tracks independent recovery allowances", () =>
    Effect.gen(function* () {
      const outcomes: Array<SessionStep.Outcome> = [
        SessionStep.Outcome.RecoverFull(),
        SessionStep.Outcome.Completed({ needsContinuation: false }),
        SessionStep.Outcome.Completed({ needsContinuation: false }),
      ]
      const recoveries = [false, true, false]
      const attempts = yield* Ref.make<ReadonlyArray<SessionStepMachine.Context>>([])
      yield* SessionStepMachine.run(firstID, {
        prepare: (context) =>
          Ref.update(attempts, (values) => [...values, context]).pipe(
            Effect.map(() =>
              SessionStepMachine.Preparation.Ready({
                attempt: makeAttempt(outcomes.shift() ?? SessionStep.Outcome.Completed({ needsContinuation: false }), {
                  recoverOverflow: recoveries.shift(),
                }),
              }),
            ),
          ),
        retry: () => Effect.void,
        publishSynthetic: Effect.void,
      })
      const observed = yield* Ref.get(attempts)
      expect(observed.slice(0, 2)).toEqual([
        { assistantMessageID: firstID, recoverOverflow: true, recoverContinuation: true },
        { assistantMessageID: firstID, recoverOverflow: true, recoverContinuation: false },
      ])
      expect(observed.at(2)).toMatchObject({ recoverOverflow: false, recoverContinuation: false })
      expect(observed.at(2)?.assistantMessageID).not.toBe(firstID)
    }),
  )

  it.effect("does not begin another attempt when retry is interrupted", () =>
    Effect.gen(function* () {
      const retryStarted = yield* Deferred.make<void>()
      const retryFinalized = yield* Deferred.make<void>()
      const attempts = yield* Ref.make(0)
      const machine = yield* SessionStepMachine.run(firstID, {
        prepare: () =>
          Ref.update(attempts, (value) => value + 1).pipe(
            Effect.as(
              SessionStepMachine.Preparation.Ready({
                attempt: makeAttempt(SessionStep.Outcome.Retry({ cause: failure, error })),
              }),
            ),
          ),
        retry: () =>
          Deferred.succeed(retryStarted, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(Deferred.succeed(retryFinalized, undefined)),
          ),
        publishSynthetic: Effect.void,
      }).pipe(Effect.forkChild({ startImmediately: true }))

      yield* Deferred.await(retryStarted)
      yield* Fiber.interrupt(machine)
      expect(Exit.hasInterrupts(yield* Fiber.await(machine))).toBe(true)
      expect(yield* Deferred.isDone(retryFinalized)).toBe(true)
      expect(yield* Ref.get(attempts)).toBe(1)
    }),
  )

  for (const outcome of [
    SessionStep.Outcome.Completed({ needsContinuation: true }),
    SessionStep.Outcome.Retry({ cause: failure, error }),
    SessionStep.Outcome.Continue({ cause: failure, error }),
    SessionStep.Outcome.RecoverFull(),
  ]) {
    it.effect(`cancellation during settlement prevents ${outcome._tag} from starting more work`, () =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const operations = yield* Ref.make<ReadonlyArray<string>>([])
        const attempt = {
          ...makeAttempt(outcome),
          settle: () =>
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.andThen(Ref.update(operations, (values) => [...values, "settled"])),
              Effect.as(outcome),
              Effect.uninterruptible,
            ),
        }
        const machine = yield* SessionStepMachine.run(firstID, {
          prepare: () =>
            Ref.update(operations, (values) => [...values, "prepare"]).pipe(
              Effect.as(SessionStepMachine.Preparation.Ready({ attempt })),
            ),
          retry: () => Ref.update(operations, (values) => [...values, "retry"]),
          publishSynthetic: Ref.update(operations, (values) => [...values, "synthetic"]),
        }).pipe(Effect.forkChild({ startImmediately: true }))

        yield* Deferred.await(started)
        const interrupted = yield* Fiber.interrupt(machine).pipe(Effect.forkChild({ startImmediately: true }))
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(interrupted)
        expect(Exit.hasInterrupts(yield* Fiber.await(machine))).toBe(true)
        expect(yield* Ref.get(operations)).toEqual(["prepare", "settled"])
      }),
    )
  }

  it.effect("cancels provider and tools together, then closes and settles once", () =>
    Effect.gen(function* () {
      const providerStarted = yield* Deferred.make<void>()
      const providerStopped = yield* Deferred.make<void>()
      const toolStarted = yield* Deferred.make<void>()
      const toolStopped = yield* Deferred.make<void>()
      const operations = yield* Ref.make<ReadonlyArray<string>>([])
      const calls = [{ type: "tool-call", id: "call_parallel", name: "lookup", input: {} }] as const
      const pending = [...calls]
      const attempt: SessionStep.Attempt = {
        ...makeAttempt(SessionStep.Outcome.Completed({ needsContinuation: false }), { operations }),
        observeUntilBoundary: () =>
          Effect.suspend(() => {
            const call = pending.shift()
            if (call) return Effect.succeed(SessionStep.ProviderObservation.ToolCall({ call }))
            return Deferred.succeed(providerStarted, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(
                Deferred.succeed(providerStopped, undefined).pipe(Effect.andThen(Deferred.await(toolStopped))),
              ),
            )
          }),
        runTool: () =>
          Deferred.succeed(toolStarted, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(
              Deferred.succeed(toolStopped, undefined).pipe(Effect.andThen(Deferred.await(providerStopped))),
            ),
          ),
        settle: (settlement) =>
          Effect.sync(() => {
            expect(Exit.hasInterrupts(settlement.stream)).toBe(true)
            expect(settlement.tools).toHaveLength(1)
            expect(settlement.tools[0]?.call).toEqual(calls[0])
            expect(settlement.tools.every((tool) => Exit.hasInterrupts(tool.exit))).toBe(true)
          }).pipe(
            Effect.andThen(Ref.update(operations, (values) => [...values, "settle"])),
            Effect.as(SessionStep.Outcome.Completed({ needsContinuation: false })),
          ),
      }
      const machine = yield* SessionStepMachine.run(firstID, {
        prepare: () => Effect.succeed(SessionStepMachine.Preparation.Ready({ attempt })),
        retry: () => Effect.die("Unexpected retry"),
        publishSynthetic: Effect.die("Unexpected continuation"),
      }).pipe(Effect.forkChild({ startImmediately: true }))

      yield* Deferred.await(providerStarted)
      yield* Deferred.await(toolStarted)
      yield* Fiber.interrupt(machine)
      expect(Exit.hasInterrupts(yield* Fiber.await(machine))).toBe(true)
      expect(yield* Ref.get(operations)).toEqual(["finish-provider", "settle"])
    }),
  )

  it.effect("does not finalize the provider twice when cancellation races with finalization", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const operations = yield* Ref.make<ReadonlyArray<string>>([])
      const attempt = {
        ...makeAttempt(SessionStep.Outcome.Completed({ needsContinuation: false }), { operations }),
        finishProvider: () =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.andThen(Ref.update(operations, (values) => [...values, "finish-provider"])),
            Effect.uninterruptible,
          ),
      }
      const machine = yield* SessionStepMachine.run(firstID, {
        prepare: () => Effect.succeed(SessionStepMachine.Preparation.Ready({ attempt })),
        retry: () => Effect.die("Unexpected retry"),
        publishSynthetic: Effect.die("Unexpected continuation"),
      }).pipe(Effect.forkChild({ startImmediately: true }))

      yield* Deferred.await(started)
      const interrupted = yield* Fiber.interrupt(machine).pipe(Effect.forkChild({ startImmediately: true }))
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(interrupted)
      expect(Exit.hasInterrupts(yield* Fiber.await(machine))).toBe(true)
      expect(yield* Ref.get(operations)).toEqual(["read:end", "finish-provider", "settle"])
    }),
  )

  test("cancellation awaits provider finalization and stops pending tools before settling", () => {
    const definition = SessionStepMachine.definition<never, never>(firstID)
    const cause = Cause.interrupt(123)
    const call = { type: "tool-call", id: "call_pending", name: "lookup", input: {} } as const
    const completed = { ...call, id: "call_completed" }
    const state = SessionStepMachine.State.FinalizingProvider({
      active: {
        context: { assistantMessageID: firstID, recoverOverflow: true, recoverContinuation: true },
        attempt: makeAttempt(SessionStep.Outcome.Completed({ needsContinuation: false })),
        tools: new Map([
          [completed.id, { call: completed, exit: Exit.succeed(undefined) }],
          [call.id, { call }],
        ]),
      },
      stream: Exit.succeed(undefined),
    })
    const stopping = definition.transition(state, {
      _tag: "Input",
      input: SessionStepMachine.Event.CancelRequested(),
      cause,
    })
    if (stopping._tag !== "Continue") throw new Error("Expected cancellation to await owned invocations")
    expect(stopping.state).toEqual({ _tag: "Stopping", from: state, cause })
    expect(stopping.commands).toEqual([
      { _tag: "StopAndJoin", id: "step", ids: ["tool:call_pending"], waitFor: ["provider"] },
    ])
    expect(
      definition.transition(stopping.state, {
        _tag: "Input",
        input: SessionStepMachine.Event.CancelRequested(),
        cause,
      }),
    ).toEqual({ _tag: "Continue", state: stopping.state, commands: [] })

    const settling = definition.transition(stopping.state, {
      _tag: "InvocationsStopped",
      id: "step",
      exits: [
        {
          _tag: "InvocationExited",
          id: "tool:call_pending",
          generation: 1,
          operation: SessionStepMachine.Operation.RunTool({ attempt: state.active.attempt, call }),
          exit: Exit.interrupt(456),
        },
        {
          _tag: "InvocationExited",
          id: "provider",
          generation: 2,
          operation: SessionStepMachine.Operation.FinishProvider({
            attempt: state.active.attempt,
            stream: state.stream,
          }),
          exit: Exit.succeed(SessionStepMachine.Event.ProviderFinished({ exit: Exit.succeed(undefined) })),
        },
      ],
    })
    if (settling._tag !== "Continue") throw new Error("Expected settlement after the joined batch")
    expect(settling.state).toMatchObject({ _tag: "SettlingAttempt", stopping: cause })
    expect(settling.commands).toEqual([
      {
        _tag: "Invoke",
        id: "settlement",
        operation: {
          _tag: "SettleAttempt",
          attempt: state.active.attempt,
          settlement: {
            stream: state.stream,
            tools: [
              { call: completed, exit: Exit.succeed(undefined) },
              { call, exit: Exit.interrupt(456) },
            ],
          },
        },
      },
    ])
  })

  for (const fixture of [
    { name: "never-started", exit: Exit.interrupt(456), replaced: false },
    {
      name: "queued false",
      exit: Exit.succeed(SessionStepMachine.Event.OverflowRecovered({ exit: Exit.succeed(false) })),
      replaced: false,
    },
    {
      name: "queued failure",
      exit: Exit.succeed(SessionStepMachine.Event.OverflowRecovered({ exit: Exit.die("Recovery failed") })),
      replaced: false,
    },
    {
      name: "queued true",
      exit: Exit.succeed(SessionStepMachine.Event.OverflowRecovered({ exit: Exit.succeed(true) })),
      replaced: true,
    },
  ] as const) {
    test(`cancellation reconciles ${fixture.name} overflow recovery before deciding settlement`, () => {
      const definition = SessionStepMachine.definition<never, never>(firstID)
      const cause = Cause.interrupt(123)
      const state = SessionStepMachine.State.RecoveringOverflow({
        active: {
          context: { assistantMessageID: firstID, recoverOverflow: true, recoverContinuation: true },
          attempt: makeAttempt(SessionStep.Outcome.Completed({ needsContinuation: true })),
          tools: new Map(),
        },
        stream: Exit.succeed(undefined),
      })
      const stopping = definition.transition(state, {
        _tag: "Input",
        input: SessionStepMachine.Event.CancelRequested(),
        cause,
      })
      if (stopping._tag !== "Continue") throw new Error("Expected cancellation to await recovery")
      expect(stopping.state).toEqual({ _tag: "Stopping", from: state, cause })
      expect(stopping.commands).toEqual([{ _tag: "StopAndJoin", id: "step", ids: ["compaction"], waitFor: [] }])

      const settled = definition.transition(stopping.state, {
        _tag: "InvocationsStopped",
        id: "step",
        exits: [
          {
            _tag: "InvocationExited",
            id: "compaction",
            generation: 1,
            operation: SessionStepMachine.Operation.RecoverOverflow({
              attempt: state.active.attempt,
              settlement: { stream: state.stream, tools: [] },
            }),
            exit: fixture.exit,
          },
        ],
      })
      if (fixture.replaced) {
        expect(settled).toEqual({ _tag: "Done", output: Exit.failCause(cause) })
        return
      }
      if (settled._tag !== "Continue") throw new Error("Expected the unreplaced attempt to settle")
      expect(settled.state).toEqual({ _tag: "SettlingAttempt", active: state.active, stopping: cause })
      expect(settled.commands).toEqual([
        {
          _tag: "Invoke",
          id: "settlement",
          operation: {
            _tag: "SettleAttempt",
            attempt: state.active.attempt,
            settlement: { stream: Exit.failCause(cause), tools: [] },
          },
        },
      ])
      const command = settled.commands[0]
      if (command?._tag !== "Invoke") throw new Error("Expected a settlement invocation")
      expect(
        definition.transition(settled.state, {
          _tag: "InvocationExited",
          id: command.id,
          generation: 2,
          operation: command.operation,
          exit: Exit.succeed(
            SessionStepMachine.Event.AttemptSettled({
              exit: Exit.succeed(SessionStep.Outcome.Completed({ needsContinuation: true })),
            }),
          ),
        }),
      ).toEqual({ _tag: "Done", output: Exit.failCause(cause) })
    })
  }

  for (const target of ["finishProvider", "recoverOverflow"] as const) {
    it.effect(`settles once when cancellation precedes ${target} execution`, () =>
      Effect.gen(function* () {
        const operations = yield* Ref.make<ReadonlyArray<string>>([])
        const attempt = makeAttempt(SessionStep.Outcome.Completed({ needsContinuation: true }), { operations })
        const machine = yield* Effect.withFiber((fiber) =>
          SessionStepMachine.run(firstID, {
            prepare: () =>
              Effect.succeed(
                SessionStepMachine.Preparation.Ready({
                  attempt: {
                    ...attempt,
                    // Interrupt during construction, before the deferred invocation starts.
                    finishProvider: (stream) => {
                      if (target === "finishProvider") fiber.interruptUnsafe(123)
                      return attempt.finishProvider(stream)
                    },
                    recoverOverflow: (settlement) => {
                      if (target === "recoverOverflow") fiber.interruptUnsafe(123)
                      return attempt.recoverOverflow(settlement)
                    },
                  },
                }),
              ),
            retry: () => Effect.die("Unexpected retry"),
            publishSynthetic: Effect.die("Unexpected continuation"),
          }),
        ).pipe(
          Effect.provideService(Scheduler.PreventSchedulerYield, true),
          Effect.forkChild({ startImmediately: true }),
        )

        expect(Exit.hasInterrupts(yield* Fiber.await(machine))).toBe(true)
        expect(yield* Ref.get(operations)).toEqual(["read:end", "finish-provider", "settle"])
      }),
    )
  }
})

function makeAttempt(
  outcome: SessionStep.Outcome,
  options?: {
    readonly events?: ReadonlyArray<LLMEvent>
    readonly operations?: Ref.Ref<ReadonlyArray<string>>
    readonly recoverOverflow?: boolean
  },
): SessionStep.Attempt {
  const events = [...(options?.events ?? [])]
  const log = (value: string) =>
    options?.operations ? Ref.update(options.operations, (values) => [...values, value]) : Effect.void
  return {
    observeUntilBoundary: () =>
      Effect.gen(function* () {
        const event = events.shift()
        yield* log(event ? `read:${event.type}` : "read:end")
        if (!event) return SessionStep.ProviderObservation.ProviderEnd()
        yield* log(`publish:${event.type}`)
        if (event.type !== "tool-call") return SessionStep.ProviderObservation.ProviderEnd()
        return SessionStep.ProviderObservation.ToolCall({ call: event })
      }),
    runTool: (call) => log(`tool:${call.id}`),
    finishProvider: () => log("finish-provider"),
    recoverOverflow: () => Effect.succeed(options?.recoverOverflow ?? false),
    settle: () => log("settle").pipe(Effect.as(outcome)),
  }
}
