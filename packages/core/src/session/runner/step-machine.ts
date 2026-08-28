export * as SessionStepMachine from "./step-machine.js"

import { AIError, type ToolCall } from "@opencode-ai/ai"
import { Cause, Data, Effect, Exit } from "effect"
import { StateMachine } from "../../effect/state-machine.js"
import { StepFailedError } from "../error.js"
import { SessionMessage } from "../message.js"
import { SessionStep } from "./step.js"

const PREPARATION = "preparation"
const PROVIDER = "provider"
const COMPACTION = "compaction"
const SETTLEMENT = "settlement"
const RETRY = "retry"

export type Context = {
  readonly assistantMessageID: SessionMessage.ID
  readonly recoverOverflow: boolean
  readonly recoverContinuation: boolean
}

export type Preparation = Data.TaggedEnum<{
  Rebuilt: {}
  Ready: { readonly attempt: SessionStep.Attempt }
}>
export const Preparation = Data.taggedEnum<Preparation>()

type AttemptFailure = AIError | StepFailedError

type ToolRun = {
  readonly call: ToolCall
  readonly exit?: SessionStep.ToolExit
}

type ActiveAttempt = {
  readonly context: Context
  readonly attempt: SessionStep.Attempt
  readonly tools: ReadonlyMap<string, ToolRun>
}

type AttemptState =
  | { readonly _tag: "ObservingProvider"; readonly active: ActiveAttempt }
  | {
      readonly _tag: "FinalizingProvider"
      readonly active: ActiveAttempt
      readonly stream: Exit.Exit<void, AIError>
      readonly stopping?: Cause.Cause<never>
    }
  | {
      readonly _tag: "AwaitingTools"
      readonly active: ActiveAttempt
      readonly stream: Exit.Exit<void, AIError>
    }
  | {
      readonly _tag: "RecoveringOverflow"
      readonly active: ActiveAttempt
      readonly stream: Exit.Exit<void, AIError>
    }

export type State =
  | AttemptState
  | { readonly _tag: "PreparingAttempt"; readonly context: Context }
  | {
      readonly _tag: "SettlingAttempt"
      readonly active: ActiveAttempt
      readonly stopping?: Cause.Cause<never>
    }
  | {
      readonly _tag: "BackingOff"
      readonly context: Context
      readonly outcome: Extract<SessionStep.Outcome, { readonly _tag: "Retry" | "Continue" }>
    }
  | {
      readonly _tag: "Stopping"
      readonly from?: AttemptState
      readonly cause: Cause.Cause<never>
    }

export type Event<Failure> =
  | {
      readonly _tag: "Prepared"
      readonly exit: Exit.Exit<{ readonly context: Context; readonly preparation: Preparation }, Failure>
    }
  | { readonly _tag: "ProviderObserved"; readonly exit: Exit.Exit<SessionStep.ProviderObservation, AIError> }
  | { readonly _tag: "ToolFinished"; readonly call: ToolCall; readonly exit: SessionStep.ToolExit }
  | { readonly _tag: "ProviderFinished"; readonly exit: Exit.Exit<void> }
  | { readonly _tag: "OverflowRecovered"; readonly exit: Exit.Exit<boolean> }
  | { readonly _tag: "AttemptSettled"; readonly exit: Exit.Exit<SessionStep.Outcome, AttemptFailure> }
  | { readonly _tag: "RetryFinished"; readonly exit: Exit.Exit<void, Failure> }
  | { readonly _tag: "CancelRequested" }

export type Operation =
  | { readonly _tag: "PrepareAttempt"; readonly context: Context; readonly freshAssistant: boolean }
  | { readonly _tag: "ObserveProvider"; readonly attempt: SessionStep.Attempt }
  | { readonly _tag: "RunTool"; readonly attempt: SessionStep.Attempt; readonly call: ToolCall }
  | {
      readonly _tag: "FinishProvider"
      readonly attempt: SessionStep.Attempt
      readonly stream: Exit.Exit<void, AIError>
    }
  | {
      readonly _tag: "RecoverOverflow"
      readonly attempt: SessionStep.Attempt
      readonly settlement: SessionStep.Settlement
    }
  | {
      readonly _tag: "SettleAttempt"
      readonly attempt: SessionStep.Attempt
      readonly settlement: SessionStep.Settlement
    }
  | {
      readonly _tag: "Retry"
      readonly context: Context
      readonly outcome: Extract<SessionStep.Outcome, { readonly _tag: "Retry" | "Continue" }>
    }

export type Capabilities<Failure, RetryFailure, Requirements> = {
  readonly prepare: (context: Context) => Effect.Effect<Preparation, Failure, Requirements>
  readonly retry: (
    context: Context,
    outcome: Extract<SessionStep.Outcome, { readonly _tag: "Retry" | "Continue" }>,
  ) => Effect.Effect<void, RetryFailure, Requirements>
  readonly publishSynthetic: Effect.Effect<void, Failure, Requirements>
}

export const run = Effect.fn("SessionStepMachine.run")(function* <Failure, RetryFailure, Requirements>(
  assistantMessageID: SessionMessage.ID,
  capabilities: Capabilities<Failure, RetryFailure, Requirements>,
) {
  const execute = (operation: Operation) => {
    switch (operation._tag) {
      case "PrepareAttempt":
        return Effect.suspend(() => {
          const context = operation.freshAssistant
            ? { ...operation.context, assistantMessageID: SessionMessage.ID.create() }
            : operation.context
          return capabilities.prepare(context).pipe(Effect.map((preparation) => ({ context, preparation })))
        }).pipe(
          Effect.exit,
          Effect.map((exit) => ({ _tag: "Prepared" as const, exit })),
        )
      case "ObserveProvider":
        return operation.attempt.observeUntilBoundary().pipe(
          Effect.exit,
          Effect.map((exit) => ({ _tag: "ProviderObserved" as const, exit })),
        )
      case "RunTool":
        return operation.attempt.runTool(operation.call).pipe(
          Effect.exit,
          Effect.map((exit) => ({ _tag: "ToolFinished" as const, call: operation.call, exit })),
        )
      case "FinishProvider":
        return operation.attempt.finishProvider(operation.stream).pipe(
          Effect.exit,
          Effect.map((exit) => ({ _tag: "ProviderFinished" as const, exit })),
        )
      case "RecoverOverflow":
        return operation.attempt.recoverOverflow(operation.settlement).pipe(
          Effect.exit,
          Effect.map((exit) => ({ _tag: "OverflowRecovered" as const, exit })),
        )
      case "SettleAttempt":
        return operation.attempt.settle(operation.settlement).pipe(
          Effect.exit,
          Effect.map((exit) => ({ _tag: "AttemptSettled" as const, exit })),
        )
      case "Retry":
        return capabilities.retry(operation.context, operation.outcome).pipe(
          Effect.andThen(operation.outcome._tag === "Continue" ? capabilities.publishSynthetic : Effect.void),
          Effect.exit,
          Effect.map((exit) => ({ _tag: "RetryFinished" as const, exit })),
        )
    }
    return unexpectedOperation(operation)
  }
  const result = yield* StateMachine.run(definition<Failure, RetryFailure>(assistantMessageID), execute)
  return yield* result
})

export const definition = <Failure, RetryFailure>(assistantMessageID: SessionMessage.ID) => {
  const context = {
    assistantMessageID,
    recoverOverflow: true,
    recoverContinuation: true,
  }
  type MachineFailure = Failure | RetryFailure | AttemptFailure
  type Decision = StateMachine.Decision<State, Operation, Exit.Exit<boolean, MachineFailure>>

  const prepare = (context: Context, freshAssistant = false): StateMachine.Continue<State, Operation> =>
    StateMachine.next(
      { _tag: "PreparingAttempt", context },
      StateMachine.invoke(PREPARATION, { _tag: "PrepareAttempt", context, freshAssistant }),
    )

  const pull = (active: ActiveAttempt): Decision =>
    StateMachine.next(
      { _tag: "ObservingProvider", active },
      StateMachine.invoke(PROVIDER, { _tag: "ObserveProvider", attempt: active.attempt }),
    )

  const settlement = (active: ActiveAttempt, stream: Exit.Exit<void, AIError>): SessionStep.Settlement => ({
    stream,
    tools: Array.from(active.tools.values()).flatMap((tool) =>
      tool.exit ? [{ call: tool.call, exit: tool.exit }] : [],
    ),
  })

  const settle = (active: ActiveAttempt, stream: Exit.Exit<void, AIError>, stopping?: Cause.Cause<never>): Decision =>
    StateMachine.next(
      { _tag: "SettlingAttempt", active, stopping },
      StateMachine.invoke(SETTLEMENT, {
        _tag: "SettleAttempt",
        attempt: active.attempt,
        settlement: settlement(active, stream),
      }),
    )

  const afterProvider = (active: ActiveAttempt, stream: Exit.Exit<void, AIError>): Decision => {
    if (Array.from(active.tools.values()).some((tool) => tool.exit === undefined))
      return StateMachine.next({ _tag: "AwaitingTools", active, stream })
    if (!active.context.recoverOverflow) return settle(active, stream)
    return StateMachine.next(
      { _tag: "RecoveringOverflow", active, stream },
      StateMachine.invoke(COMPACTION, {
        _tag: "RecoverOverflow",
        attempt: active.attempt,
        settlement: settlement(active, stream),
      }),
    )
  }

  const finishProvider = (
    active: ActiveAttempt,
    stream: Exit.Exit<void, AIError>,
    stopping?: Cause.Cause<never>,
  ): Decision =>
    StateMachine.next(
      { _tag: "FinalizingProvider", active, stream, stopping },
      StateMachine.invoke(PROVIDER, {
        _tag: "FinishProvider",
        attempt: active.attempt,
        stream,
      }),
    )

  const stop = (cause: Cause.Cause<never>, ids: ReadonlyArray<string>, from?: AttemptState): Decision => {
    return StateMachine.next(
      { _tag: "Stopping", cause, from },
      StateMachine.stopAndJoin("step", ids, from?._tag === "FinalizingProvider" ? [PROVIDER] : []),
    )
  }

  const interrupt = (state: State, cause: Cause.Cause<never>): Decision => {
    switch (state._tag) {
      case "PreparingAttempt":
        return stop(cause, [PREPARATION])
      case "ObservingProvider":
      case "FinalizingProvider":
      case "AwaitingTools":
        return stop(
          cause,
          [
            ...(state._tag === "ObservingProvider" ? [PROVIDER] : []),
            ...Array.from(state.active.tools.values()).flatMap((tool) =>
              tool.exit === undefined ? [toolID(tool.call)] : [],
            ),
          ],
          state,
        )
      case "SettlingAttempt":
        return StateMachine.next({ ...state, stopping: cause })
      case "RecoveringOverflow":
        return stop(cause, [COMPACTION], state)
      case "BackingOff":
        return stop(cause, [RETRY])
      case "Stopping":
        return StateMachine.next(state)
    }
    return unexpectedState(state)
  }

  return StateMachine.define<
    State,
    Event<Failure | RetryFailure>,
    Operation,
    never,
    Exit.Exit<boolean, MachineFailure>
  >({
    initial: prepare(context),
    interruption: { _tag: "CancelRequested" },
    transition: (state, runtimeEvent): Decision => {
      if (runtimeEvent._tag === "Input") return interrupt(state, runtimeEvent.cause ?? Cause.interrupt(undefined))
      if (runtimeEvent._tag === "InvocationsStopped") {
        if (state._tag !== "Stopping") return unexpected(state, runtimeEvent)
        if (!state.from) return StateMachine.done(Exit.failCause(state.cause))
        const finished = runtimeEvent.exits.map(completed)
        if (state.from._tag === "RecoveringOverflow") {
          const recovered = finished.some(
            (event) => event._tag === "OverflowRecovered" && Exit.isSuccess(event.exit) && event.exit.value,
          )
          return recovered
            ? StateMachine.done(Exit.failCause(state.cause))
            : settle(state.from.active, Exit.failCause(state.cause), state.cause)
        }
        const tools = new Map(state.from.active.tools)
        finished.forEach((event) => {
          if (event._tag === "ToolFinished") tools.set(event.call.id, { call: event.call, exit: event.exit })
        })
        const active = { ...state.from.active, tools }
        if (state.from._tag === "ObservingProvider")
          return finishProvider(active, Exit.failCause(state.cause), state.cause)
        const provider = finished.find((event) => event._tag === "ProviderFinished")
        const stream =
          provider && Exit.isFailure(provider.exit) ? Exit.failCause(provider.exit.cause) : state.from.stream
        return settle(active, stream, state.cause)
      }

      const event = completed(runtimeEvent)
      if (event._tag === "ToolFinished") {
        if (
          state._tag === "ObservingProvider" ||
          state._tag === "FinalizingProvider" ||
          state._tag === "AwaitingTools"
        ) {
          const tools = new Map(state.active.tools)
          tools.set(event.call.id, { call: event.call, exit: event.exit })
          const active = { ...state.active, tools }
          return state._tag === "AwaitingTools"
            ? afterProvider(active, state.stream)
            : StateMachine.next({ ...state, active })
        }
        return unexpected(state, event)
      }

      switch (state._tag) {
        case "PreparingAttempt": {
          if (event._tag !== "Prepared") return unexpected(state, event)
          if (Exit.isFailure(event.exit)) return StateMachine.done(Exit.failCause(event.exit.cause))
          if (event.exit.value.preparation._tag === "Rebuilt") return prepare(event.exit.value.context, true)
          const active = {
            context: event.exit.value.context,
            attempt: event.exit.value.preparation.attempt,
            tools: new Map<string, ToolRun>(),
          }
          return pull(active)
        }
        case "ObservingProvider": {
          if (event._tag !== "ProviderObserved") return unexpected(state, event)
          if (Exit.isFailure(event.exit)) return finishProvider(state.active, Exit.failCause(event.exit.cause))
          const observed = event.exit.value
          if (observed._tag === "ProviderEnd") return finishProvider(state.active, Exit.succeed(undefined))
          const tools = new Map(state.active.tools)
          tools.set(observed.call.id, { call: observed.call })
          const next = { ...state.active, tools }
          return StateMachine.next(
            { _tag: "ObservingProvider", active: next },
            StateMachine.invoke<Operation>(toolID(observed.call), {
              _tag: "RunTool",
              attempt: next.attempt,
              call: observed.call,
            }),
            StateMachine.invoke<Operation>(PROVIDER, { _tag: "ObserveProvider", attempt: next.attempt }),
          )
        }
        case "FinalizingProvider": {
          if (event._tag !== "ProviderFinished") return unexpected(state, event)
          const stream = Exit.isFailure(event.exit) ? Exit.failCause(event.exit.cause) : state.stream
          return state.stopping ? settle(state.active, stream, state.stopping) : afterProvider(state.active, stream)
        }
        case "RecoveringOverflow": {
          if (event._tag !== "OverflowRecovered") return unexpected(state, event)
          if (Exit.isFailure(event.exit)) return StateMachine.done(Exit.failCause(event.exit.cause))
          if (!event.exit.value) return settle(state.active, state.stream)
          const context = { ...state.active.context, recoverOverflow: false }
          return prepare(context, true)
        }
        case "SettlingAttempt": {
          if (event._tag !== "AttemptSettled") return unexpected(state, event)
          if (state.stopping) return StateMachine.done(Exit.failCause(state.stopping))
          if (Exit.isFailure(event.exit)) return StateMachine.done(Exit.failCause(event.exit.cause))
          const outcome = event.exit.value
          if (outcome._tag === "Completed") return StateMachine.done(Exit.succeed(outcome.needsContinuation))
          if (outcome._tag === "Retry" || outcome._tag === "Continue")
            return StateMachine.next(
              { _tag: "BackingOff", context: state.active.context, outcome },
              StateMachine.invoke(RETRY, { _tag: "Retry", context: state.active.context, outcome }),
            )
          if (outcome._tag === "RecoverFull") {
            const context = { ...state.active.context, recoverContinuation: false }
            return prepare(context)
          }
          return unexpectedOutcome(outcome)
        }
        case "BackingOff": {
          if (event._tag !== "RetryFinished") return unexpected(state, event)
          if (Exit.isFailure(event.exit)) return StateMachine.done(Exit.failCause(event.exit.cause))
          return prepare(state.context, state.outcome._tag === "Continue")
        }
        case "AwaitingTools":
        case "Stopping":
          return unexpected(state, event)
      }
      return unexpectedState(state)
    },
  })
}

const toolID = (call: ToolCall) => `tool:${call.id}`

// Pre-start interruption can bypass the interpreter's Effect.exit.
// Normalize outer failures once without erasing operation-specific error types.
function completed<Failure>(
  invocation: StateMachine.InvocationExited<Event<Failure>, Operation, never>,
): Event<Failure> {
  if (Exit.isSuccess(invocation.exit)) return invocation.exit.value
  const exit = Exit.failCause(invocation.exit.cause)
  switch (invocation.operation._tag) {
    case "PrepareAttempt":
      return { _tag: "Prepared", exit }
    case "ObserveProvider":
      return { _tag: "ProviderObserved", exit }
    case "RunTool":
      return { _tag: "ToolFinished", call: invocation.operation.call, exit }
    case "FinishProvider":
      return { _tag: "ProviderFinished", exit }
    case "RecoverOverflow":
      return { _tag: "OverflowRecovered", exit }
    case "SettleAttempt":
      return { _tag: "AttemptSettled", exit }
    case "Retry":
      return { _tag: "RetryFinished", exit }
  }
  return unexpectedOperation(invocation.operation)
}

function unexpected(state: State, event: { readonly _tag: string }): never {
  throw new Error(`Unexpected ${event._tag} event while Session Step machine is ${state._tag}`)
}

function unexpectedOperation(operation: never): never {
  throw new Error(`Unexpected Session Step operation: ${String(operation)}`)
}

function unexpectedOutcome(outcome: never): never {
  throw new Error(`Unexpected Session Step outcome: ${String(outcome)}`)
}

function unexpectedState(state: never): never {
  throw new Error(`Unexpected Session Step state: ${String(state)}`)
}
