export * as StateMachine from "./state-machine.js"

import { Cause, Effect, Exit, Fiber, Queue, type Scope } from "effect"

export type Command<Operation> =
  | {
      readonly _tag: "Invoke"
      readonly id: string
      readonly operation: Operation
    }
  | {
      readonly _tag: "Stop"
      readonly id: string
    }
  | {
      readonly _tag: "StopAndJoin"
      readonly id: string
      readonly ids: ReadonlyArray<string>
      readonly waitFor: ReadonlyArray<string>
    }

export type InvocationExited<Event, Operation, Error> = {
  readonly _tag: "InvocationExited"
  readonly id: string
  readonly generation: number
  readonly operation: Operation
  readonly exit: Exit.Exit<Event, Error>
}

export type RuntimeEvent<Event, Operation, Error> =
  | {
      readonly _tag: "Input"
      readonly input: Event
      readonly cause?: Cause.Cause<never>
    }
  | InvocationExited<Event, Operation, Error>
  | {
      readonly _tag: "InvocationsStopped"
      readonly id: string
      readonly exits: ReadonlyArray<InvocationExited<Event, Operation, Error>>
    }

export type Continue<State, Operation> = {
  readonly _tag: "Continue"
  readonly state: State
  readonly commands: ReadonlyArray<Command<Operation>>
}

export type Decision<State, Operation, Output> =
  | Continue<State, Operation>
  | {
      readonly _tag: "Done"
      readonly output: Output
    }

export type Definition<State, Event, Operation, Error, Output> = {
  readonly initial: Continue<State, Operation>
  readonly transition: (
    state: State,
    event: RuntimeEvent<Event, Operation, Error>,
  ) => Decision<State, Operation, Output>
  readonly interruption?: Event
}

export type Executor<Event, Operation, Error, Requirements> = (
  operation: Operation,
) => Effect.Effect<Event, Error, Requirements>

export function define<State, Event, Operation, Error, Output>(
  definition: Definition<State, Event, Operation, Error, Output>,
) {
  return definition
}

export function next<State, Operation = never>(state: State, ...commands: ReadonlyArray<Command<Operation>>) {
  return { _tag: "Continue", state, commands } as const
}

export function done<Output>(output: Output) {
  return { _tag: "Done", output } as const
}

export function invoke<Operation>(id: string, operation: Operation): Command<Operation> {
  return { _tag: "Invoke", id, operation }
}

export function stop(id: string): Command<never> {
  return { _tag: "Stop", id }
}

/** Stops `ids`, awaits `waitFor` without interruption, and delivers their exits as one batch. */
export function stopAndJoin(
  id: string,
  ids: ReadonlyArray<string>,
  waitFor: ReadonlyArray<string> = [],
): Command<never> {
  return { _tag: "StopAndJoin", id, ids, waitFor }
}

export const run = Effect.fn("StateMachine.run")(function* <State, Event, Operation, Error, Output, Requirements>(
  definition: Definition<State, Event, Operation, Error, Output>,
  execute: Executor<Event, Operation, Error, Requirements>,
) {
  return yield* Effect.uninterruptibleMask((restore) =>
    Effect.scoped(
      Effect.gen(function* () {
        const queue = yield* Queue.unbounded<RuntimeEvent<Event, Operation, Error>>()
        const invocations = new Map<
          string,
          {
            readonly generation: number
            readonly operation: Operation
            readonly fiber: Fiber.Fiber<Event, Error>
          }
        >()
        let generation = 0

        const executeCommands = Effect.fnUntraced(function* (
          commands: ReadonlyArray<Command<Operation>>,
          interruptibleExecution: boolean,
        ) {
          yield* Effect.forEach(
            commands,
            (command) =>
              Effect.gen(function* () {
                if (command._tag === "Stop") {
                  const invocation = invocations.get(command.id)
                  yield* invocation
                    ? Fiber.interrupt(invocation.fiber)
                    : Effect.die(new Error(`Unknown state machine invocation: ${command.id}`))
                  return
                }

                if (command._tag === "StopAndJoin") {
                  const captured = [...command.ids, ...command.waitFor].flatMap((id) => {
                    const invocation = invocations.get(id)
                    return invocation ? [{ id, ...invocation }] : []
                  })
                  if (captured.length !== command.ids.length + command.waitFor.length)
                    yield* Effect.die(new Error("Unknown state machine invocation in StopAndJoin"))

                  // Invalidate individual exits, including ones already queued, before interrupting.
                  captured.forEach((invocation) => invocations.delete(invocation.id))
                  yield* Fiber.interruptAll(captured.slice(0, command.ids.length).map((invocation) => invocation.fiber))
                  const exits = yield* Effect.forEach(captured, (invocation) =>
                    Fiber.await(invocation.fiber).pipe(
                      Effect.map((exit) => ({
                        _tag: "InvocationExited" as const,
                        id: invocation.id,
                        generation: invocation.generation,
                        operation: invocation.operation,
                        exit,
                      })),
                    ),
                  )
                  yield* Queue.offer(queue, { _tag: "InvocationsStopped", id: command.id, exits })
                  return
                }

                const previous = invocations.get(command.id)
                if (previous) yield* Fiber.interrupt(previous.fiber)

                generation += 1
                const current = generation
                const execution = interruptibleExecution
                  ? restore(execute(command.operation))
                  : execute(command.operation)
                const fiber = yield* execution.pipe(Effect.forkScoped({ startImmediately: false }))
                invocations.set(command.id, { generation: current, operation: command.operation, fiber })
                // A deferred child may be interrupted before an Effect.onExit observer starts.
                fiber.addObserver((exit) => {
                  Queue.offerUnsafe(queue, {
                    _tag: "InvocationExited",
                    id: command.id,
                    generation: current,
                    operation: command.operation,
                    exit,
                  })
                })
              }),
            { discard: true },
          )
        })

        const handleInterruption = (
          state: State,
          cause: Cause.Cause<never>,
        ): Effect.Effect<Output, never, Requirements | Scope.Scope> =>
          Effect.gen(function* () {
            if (!Cause.hasInterruptsOnly(cause) || definition.interruption === undefined)
              return yield* Effect.failCause(cause)
            return yield* dispatch(
              definition.transition(state, {
                _tag: "Input",
                input: definition.interruption,
                cause,
              }),
              true,
            )
          })

        const dispatch = (
          decision: Decision<State, Operation, Output>,
          interrupted: boolean,
        ): Effect.Effect<Output, never, Requirements | Scope.Scope> =>
          Effect.gen(function* () {
            if (decision._tag === "Done") return decision.output
            yield* executeCommands(decision.commands, !interrupted)
            if (interrupted) return yield* Effect.suspend(() => loop(decision.state, true))

            const boundary = yield* restore(Effect.void).pipe(Effect.exit)
            if (Exit.isFailure(boundary)) return yield* handleInterruption(decision.state, boundary.cause)
            return yield* Effect.suspend(() => loop(decision.state, false))
          })

        const loop = (state: State, interrupted: boolean): Effect.Effect<Output, never, Requirements | Scope.Scope> =>
          Effect.gen(function* () {
            const received = yield* (interrupted ? Queue.take(queue) : restore(Queue.take(queue))).pipe(Effect.exit)
            if (Exit.isFailure(received)) return yield* handleInterruption(state, received.cause)

            if (received.value._tag === "InvocationExited") {
              const invocation = invocations.get(received.value.id)
              if (!invocation || invocation.generation !== received.value.generation) {
                return yield* Effect.suspend(() => loop(state, interrupted))
              }
              invocations.delete(received.value.id)
            }

            return yield* dispatch(definition.transition(state, received.value), interrupted)
          })

        return yield* dispatch(definition.initial, false)
      }),
    ),
  )
})
