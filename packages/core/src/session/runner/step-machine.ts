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
type BackoffOutcome = Data.TaggedEnum.Value<SessionStep.Outcome, "Retry" | "Continue">

type ToolRun = {
  readonly call: ToolCall
  readonly exit?: SessionStep.ToolExit
}

type ActiveAttempt = {
  readonly context: Context
  readonly attempt: SessionStep.Attempt
  readonly tools: ReadonlyMap<string, ToolRun>
}

type AttemptState = Data.TaggedEnum<{
  ObservingProvider: { readonly active: ActiveAttempt }
  FinalizingProvider: {
    readonly active: ActiveAttempt
    readonly stream: Exit.Exit<void, AIError>
    readonly stopping?: Cause.Cause<never>
  }
  AwaitingTools: { readonly active: ActiveAttempt; readonly stream: Exit.Exit<void, AIError> }
  RecoveringOverflow: { readonly active: ActiveAttempt; readonly stream: Exit.Exit<void, AIError> }
}>

export type State =
  | AttemptState
  | Data.TaggedEnum<{
      PreparingAttempt: { readonly context: Context }
      SettlingAttempt: { readonly active: ActiveAttempt; readonly stopping?: Cause.Cause<never> }
      BackingOff: {
        readonly context: Context
        readonly outcome: BackoffOutcome
      }
      Stopping: { readonly from?: AttemptState; readonly cause: Cause.Cause<never> }
    }>
export const State = Data.taggedEnum<State>()

export type Event<Failure> = Data.TaggedEnum<{
  Prepared: { readonly exit: Exit.Exit<{ readonly context: Context; readonly preparation: Preparation }, Failure> }
  ProviderObserved: { readonly exit: Exit.Exit<SessionStep.ProviderObservation, AIError> }
  ToolFinished: { readonly call: ToolCall; readonly exit: SessionStep.ToolExit }
  ProviderFinished: { readonly exit: Exit.Exit<void> }
  OverflowRecovered: { readonly exit: Exit.Exit<boolean> }
  AttemptSettled: { readonly exit: Exit.Exit<SessionStep.Outcome, AttemptFailure> }
  RetryFinished: { readonly exit: Exit.Exit<void, Failure> }
  CancelRequested: {}
}>
interface EventDefinition extends Data.TaggedEnum.WithGenerics<1> {
  readonly taggedEnum: Event<this["A"]>
}
export const Event = Data.taggedEnum<EventDefinition>()

export type Operation = Data.TaggedEnum<{
  PrepareAttempt: { readonly context: Context; readonly freshAssistant: boolean }
  ObserveProvider: { readonly attempt: SessionStep.Attempt }
  RunTool: { readonly attempt: SessionStep.Attempt; readonly call: ToolCall }
  FinishProvider: { readonly attempt: SessionStep.Attempt; readonly stream: Exit.Exit<void, AIError> }
  RecoverOverflow: { readonly attempt: SessionStep.Attempt; readonly settlement: SessionStep.Settlement }
  SettleAttempt: { readonly attempt: SessionStep.Attempt; readonly settlement: SessionStep.Settlement }
  Retry: {
    readonly context: Context
    readonly outcome: BackoffOutcome
  }
}>
export const Operation = Data.taggedEnum<Operation>()

export type Capabilities<Failure, RetryFailure, Requirements> = {
  readonly prepare: (context: Context) => Effect.Effect<Preparation, Failure, Requirements>
  readonly retry: (context: Context, outcome: BackoffOutcome) => Effect.Effect<void, RetryFailure, Requirements>
  readonly publishSynthetic: Effect.Effect<void, Failure, Requirements>
}

export const run = Effect.fn("SessionStepMachine.run")(function* <Failure, RetryFailure, Requirements>(
  assistantMessageID: SessionMessage.ID,
  capabilities: Capabilities<Failure, RetryFailure, Requirements>,
) {
  const execute = Operation.$match({
    PrepareAttempt: (operation) =>
      Effect.suspend(() => {
        const context = operation.freshAssistant
          ? { ...operation.context, assistantMessageID: SessionMessage.ID.create() }
          : operation.context
        return capabilities.prepare(context).pipe(Effect.map((preparation) => ({ context, preparation })))
      }).pipe(
        Effect.exit,
        Effect.map((exit) => Event.Prepared({ exit })),
      ),
    ObserveProvider: (operation) =>
      operation.attempt.observeUntilBoundary().pipe(
        Effect.exit,
        Effect.map((exit) => Event.ProviderObserved({ exit })),
      ),
    RunTool: (operation) =>
      operation.attempt.runTool(operation.call).pipe(
        Effect.exit,
        Effect.map((exit) => Event.ToolFinished({ call: operation.call, exit })),
      ),
    FinishProvider: (operation) =>
      operation.attempt.finishProvider(operation.stream).pipe(
        Effect.exit,
        Effect.map((exit) => Event.ProviderFinished({ exit })),
      ),
    RecoverOverflow: (operation) =>
      operation.attempt.recoverOverflow(operation.settlement).pipe(
        Effect.exit,
        Effect.map((exit) => Event.OverflowRecovered({ exit })),
      ),
    SettleAttempt: (operation) =>
      operation.attempt.settle(operation.settlement).pipe(
        Effect.exit,
        Effect.map((exit) => Event.AttemptSettled({ exit })),
      ),
    Retry: (operation) =>
      capabilities.retry(operation.context, operation.outcome).pipe(
        Effect.andThen(operation.outcome._tag === "Continue" ? capabilities.publishSynthetic : Effect.void),
        Effect.exit,
        Effect.map((exit) => Event.RetryFinished({ exit })),
      ),
  })
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
      State.PreparingAttempt({ context }),
      StateMachine.invoke(PREPARATION, Operation.PrepareAttempt({ context, freshAssistant })),
    )

  const pull = (active: ActiveAttempt): Decision =>
    StateMachine.next(
      State.ObservingProvider({ active }),
      StateMachine.invoke(PROVIDER, Operation.ObserveProvider({ attempt: active.attempt })),
    )

  const settlement = (active: ActiveAttempt, stream: Exit.Exit<void, AIError>): SessionStep.Settlement => ({
    stream,
    tools: Array.from(active.tools.values()).flatMap((tool) =>
      tool.exit ? [{ call: tool.call, exit: tool.exit }] : [],
    ),
  })

  const settle = (active: ActiveAttempt, stream: Exit.Exit<void, AIError>, stopping?: Cause.Cause<never>): Decision =>
    StateMachine.next(
      State.SettlingAttempt({ active, stopping }),
      StateMachine.invoke(
        SETTLEMENT,
        Operation.SettleAttempt({
          attempt: active.attempt,
          settlement: settlement(active, stream),
        }),
      ),
    )

  const afterProvider = (active: ActiveAttempt, stream: Exit.Exit<void, AIError>): Decision => {
    if (Array.from(active.tools.values()).some((tool) => tool.exit === undefined))
      return StateMachine.next(State.AwaitingTools({ active, stream }))
    if (!active.context.recoverOverflow) return settle(active, stream)
    return StateMachine.next(
      State.RecoveringOverflow({ active, stream }),
      StateMachine.invoke(
        COMPACTION,
        Operation.RecoverOverflow({
          attempt: active.attempt,
          settlement: settlement(active, stream),
        }),
      ),
    )
  }

  const finishProvider = (
    active: ActiveAttempt,
    stream: Exit.Exit<void, AIError>,
    stopping?: Cause.Cause<never>,
  ): Decision =>
    StateMachine.next(
      State.FinalizingProvider({ active, stream, stopping }),
      StateMachine.invoke(
        PROVIDER,
        Operation.FinishProvider({
          attempt: active.attempt,
          stream,
        }),
      ),
    )

  const stop = (cause: Cause.Cause<never>, ids: ReadonlyArray<string>, from?: AttemptState): Decision => {
    return StateMachine.next(
      State.Stopping({ cause, from }),
      StateMachine.stopAndJoin("step", ids, from?._tag === "FinalizingProvider" ? [PROVIDER] : []),
    )
  }

  const interrupt = (state: State, cause: Cause.Cause<never>): Decision => {
    const stopAttempt = (state: Exclude<AttemptState, { readonly _tag: "RecoveringOverflow" }>) =>
      stop(
        cause,
        [
          ...(state._tag === "ObservingProvider" ? [PROVIDER] : []),
          ...Array.from(state.active.tools.values()).flatMap((tool) =>
            tool.exit === undefined ? [toolID(tool.call)] : [],
          ),
        ],
        state,
      )
    return State.$match(state, {
      PreparingAttempt: () => stop(cause, [PREPARATION]),
      ObservingProvider: stopAttempt,
      FinalizingProvider: stopAttempt,
      AwaitingTools: stopAttempt,
      SettlingAttempt: (state) => StateMachine.next(State.SettlingAttempt({ active: state.active, stopping: cause })),
      RecoveringOverflow: (state) => stop(cause, [COMPACTION], state),
      BackingOff: () => stop(cause, [RETRY]),
      Stopping: (state) => StateMachine.next(state),
    })
  }

  return StateMachine.define<
    State,
    Event<Failure | RetryFailure>,
    Operation,
    never,
    Exit.Exit<boolean, MachineFailure>
  >({
    initial: prepare(context),
    interruption: Event.CancelRequested(),
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

      return State.$match(state, {
        PreparingAttempt: (state) => {
          if (event._tag !== "Prepared") return unexpected(state, event)
          if (Exit.isFailure(event.exit)) return StateMachine.done(Exit.failCause(event.exit.cause))
          if (event.exit.value.preparation._tag === "Rebuilt") return prepare(event.exit.value.context, true)
          const active = {
            context: event.exit.value.context,
            attempt: event.exit.value.preparation.attempt,
            tools: new Map<string, ToolRun>(),
          }
          return pull(active)
        },
        ObservingProvider: (state) => {
          if (event._tag !== "ProviderObserved") return unexpected(state, event)
          if (Exit.isFailure(event.exit)) return finishProvider(state.active, Exit.failCause(event.exit.cause))
          const observed = event.exit.value
          if (observed._tag === "ProviderEnd") return finishProvider(state.active, Exit.succeed(undefined))
          const tools = new Map(state.active.tools)
          tools.set(observed.call.id, { call: observed.call })
          const next = { ...state.active, tools }
          return StateMachine.next(
            State.ObservingProvider({ active: next }),
            StateMachine.invoke<Operation>(
              toolID(observed.call),
              Operation.RunTool({
                attempt: next.attempt,
                call: observed.call,
              }),
            ),
            StateMachine.invoke<Operation>(PROVIDER, Operation.ObserveProvider({ attempt: next.attempt })),
          )
        },
        FinalizingProvider: (state) => {
          if (event._tag !== "ProviderFinished") return unexpected(state, event)
          const stream = Exit.isFailure(event.exit) ? Exit.failCause(event.exit.cause) : state.stream
          return state.stopping ? settle(state.active, stream, state.stopping) : afterProvider(state.active, stream)
        },
        RecoveringOverflow: (state) => {
          if (event._tag !== "OverflowRecovered") return unexpected(state, event)
          if (Exit.isFailure(event.exit)) return StateMachine.done(Exit.failCause(event.exit.cause))
          if (!event.exit.value) return settle(state.active, state.stream)
          const context = { ...state.active.context, recoverOverflow: false }
          return prepare(context, true)
        },
        SettlingAttempt: (state) => {
          if (event._tag !== "AttemptSettled") return unexpected(state, event)
          if (state.stopping) return StateMachine.done(Exit.failCause(state.stopping))
          if (Exit.isFailure(event.exit)) return StateMachine.done(Exit.failCause(event.exit.cause))
          const backoff = (outcome: BackoffOutcome) =>
            StateMachine.next(
              State.BackingOff({ context: state.active.context, outcome }),
              StateMachine.invoke(RETRY, Operation.Retry({ context: state.active.context, outcome })),
            )
          return SessionStep.Outcome.$match(event.exit.value, {
            Completed: (outcome) => StateMachine.done(Exit.succeed(outcome.needsContinuation)),
            Retry: backoff,
            Continue: backoff,
            RecoverFull: () => prepare({ ...state.active.context, recoverContinuation: false }),
          })
        },
        BackingOff: (state) => {
          if (event._tag !== "RetryFinished") return unexpected(state, event)
          if (Exit.isFailure(event.exit)) return StateMachine.done(Exit.failCause(event.exit.cause))
          return prepare(state.context, state.outcome._tag === "Continue")
        },
        AwaitingTools: (state) => unexpected(state, event),
        Stopping: (state) => unexpected(state, event),
      })
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
  return Operation.$match(invocation.operation, {
    PrepareAttempt: () => Event.Prepared({ exit }),
    ObserveProvider: () => Event.ProviderObserved({ exit }),
    RunTool: (operation) => Event.ToolFinished({ call: operation.call, exit }),
    FinishProvider: () => Event.ProviderFinished({ exit }),
    RecoverOverflow: () => Event.OverflowRecovered({ exit }),
    SettleAttempt: () => Event.AttemptSettled({ exit }),
    Retry: () => Event.RetryFinished({ exit }),
  })
}

function unexpected(state: State, event: { readonly _tag: string }): never {
  throw new Error(`Unexpected ${event._tag} event while Session Step machine is ${state._tag}`)
}
