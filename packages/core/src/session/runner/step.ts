export * as SessionStep from "./step.js"

import {
  AIError,
  InvalidProviderOutputError,
  LLMClient,
  LLMEvent,
  isContextOverflowFailure,
  type ProviderErrorEvent,
  type ToolCall,
} from "@opencode-ai/ai"
import { Cause, Data, Effect, Exit, Option, Pull, Scope, Stream } from "effect"
import { SessionError } from "@opencode-ai/schema/session-error"
import { Agent } from "../../agent.js"
import { Bus } from "../../bus.js"
import { Permission } from "../../permission.js"
import { Snapshot } from "../../snapshot.js"
import { ToolOutput } from "../../tool-output.js"
import { QuestionTool } from "../../tool/plugin/question.js"
import { StepFailedError } from "../error.js"
import { SessionEvent } from "../event.js"
import { SessionMessage } from "../message.js"
import { SessionModelRequest } from "../model-request.js"
import { SessionSchema } from "../schema.js"
import { toSessionError } from "../to-session-error.js"
import { SessionUsage } from "../usage.js"
import { SessionRunnerModel } from "./model.js"
import { createLLMEventPublisher } from "./publish-llm-event.js"
import { SessionRunnerRetry } from "./retry.js"

export type Outcome = Data.TaggedEnum<{
  Completed: { readonly needsContinuation: boolean }
  Retry: { readonly cause: AIError; readonly error: SessionError.Error }
  Continue: { readonly cause: AIError; readonly error: SessionError.Error }
  RecoverFull: {}
}>
export const Outcome = Data.taggedEnum<Outcome>()

export interface Input {
  readonly sessionID: SessionSchema.ID
  readonly assistantMessageID: SessionMessage.ID
  readonly agent: Agent.ID
  readonly model: SessionRunnerModel.Resolved
  readonly prepared: SessionModelRequest.Prepared
  readonly recoverContinuation: boolean
  /** The runner owns compaction policy; the attempt invokes it only before durable output. */
  readonly recoverOverflow: Effect.Effect<boolean>
}

export type ProviderObservation = Data.TaggedEnum<{
  ToolCall: { readonly call: ToolCall }
  ProviderEnd: {}
}>
export const ProviderObservation = Data.taggedEnum<ProviderObservation>()

export type ToolExit = Exit.Exit<void, Permission.DeclinedError | QuestionTool.CancelledError>

export interface Settlement {
  readonly stream: Exit.Exit<void, AIError>
  readonly tools: ReadonlyArray<{ readonly call: ToolCall; readonly exit: ToolExit }>
}

export interface Attempt {
  readonly observeUntilBoundary: () => Effect.Effect<ProviderObservation, AIError>
  readonly runTool: (call: ToolCall) => Effect.Effect<void, Permission.DeclinedError | QuestionTool.CancelledError>
  readonly finishProvider: (stream: Exit.Exit<void, AIError>) => Effect.Effect<void>
  readonly recoverOverflow: (settlement: Settlement) => Effect.Effect<boolean>
  readonly settle: (settlement: Settlement) => Effect.Effect<Outcome, AIError | StepFailedError>
}

const TOOLS_INTERRUPTED = { type: "aborted", message: "Tool execution interrupted" } as const
const STEP_INTERRUPTED = { type: "aborted", message: "Step interrupted" } as const
const RESULT_MISSING = { type: "tool.result-missing", message: "Provider did not return a tool result" } as const

/** Captures Location-scoped dependencies without introducing another service or execution loop. */
export const make = Effect.gen(function* () {
  const bus = yield* Bus.Service
  const llm = yield* LLMClient.Service
  const snapshots = yield* Snapshot.Service
  const toolOutput = yield* ToolOutput.Service

  const open = Effect.fn("SessionStep.open")(function* (input: Input) {
    const startSnapshot = yield* snapshots.capture()
    const publisher = createLLMEventPublisher(bus, {
      sessionID: input.sessionID,
      assistantMessageID: input.assistantMessageID,
      agent: input.agent,
      model: input.model.ref,
      providerMetadataKey: input.model.model.route.providerMetadataKey ?? input.model.model.provider,
      snapshot: startSnapshot,
    })
    const scope = yield* Scope.Scope
    const providerScope = yield* Scope.fork(scope)
    const pull = yield* llm
      .stream(input.prepared.request, input.prepared.options)
      .pipe(Stream.ensuring(publisher.flush()), Stream.toPull, Scope.provide(providerScope))
    let buffered: ReadonlyArray<LLMEvent> = []
    let offset = 0
    let overflowFailure: ProviderErrorEvent | undefined

    const observeUntilBoundary = Effect.fnUntraced(function* (): Effect.fn.Return<ProviderObservation, AIError> {
      while (true) {
        const event = buffered[offset]
        if (event) {
          offset += 1
          if (overflowFailure || publisher.hasProviderError()) continue
          if (
            LLMEvent.is.providerError(event) &&
            isContextOverflowFailure(event) &&
            !publisher.record().outputStarted
          ) {
            overflowFailure = event
            continue
          }
          // Keep the publisher's in-memory mark and durable write indivisible under cancellation.
          yield* publisher.publish(event).pipe(Effect.uninterruptible)
          if (event.type === "tool-call" && !event.providerExecuted)
            return ProviderObservation.ToolCall({ call: event })
          continue
        }
        const chunk = yield* pull.pipe(Pull.catchDone(() => Effect.succeed(undefined)))
        if (!chunk) return ProviderObservation.ProviderEnd()
        buffered = chunk
        offset = 0
      }
    })

    const runTool = Effect.fnUntraced(function* (call: ToolCall) {
      return yield* Effect.uninterruptibleMask((restore) => {
        if (input.prepared.request.toolChoice?.type === "none")
          return publisher
            .failTool(call.id, { type: "tool.execution", message: "Tools are disabled after the maximum agent steps" })
            .pipe(Effect.asVoid)
        return restore(
          input.prepared.executeTool({
            sessionID: input.sessionID,
            agent: input.agent,
            messageID: input.assistantMessageID,
            call,
            progress: (update) => publisher.progress(call.id, update),
          }),
        ).pipe(
          Effect.flatMap(toolOutput.truncate),
          Effect.flatMap((outcome) => publisher.toolExecution(call.id, call.name, outcome)),
          Effect.catchTag("Tool.Error", (error) =>
            publisher.failTool(call.id, toSessionError(error), error.metadata).pipe(Effect.asVoid),
          ),
        )
      })
    })

    const finishProvider = Effect.fnUntraced(function* (stream: Exit.Exit<void, AIError>) {
      yield* Scope.close(providerScope, stream)
      if (!overflowFailure && publisher.hasStarted()) yield* publisher.streamed()
    }, Effect.uninterruptible)

    const recoverOverflow = (settlement: Settlement) => {
      if (publisher.record().outputStarted) return Effect.succeed(false)
      const failure = overflowFailure ?? Option.getOrUndefined(Exit.findErrorOption(settlement.stream))
      return isContextOverflowFailure(failure) ? input.recoverOverflow : Effect.succeed(false)
    }

    const settle = Effect.fn("SessionStep.settle")(function* (settlement: Settlement) {
      const streamFailure = Option.getOrUndefined(Exit.findErrorOption(settlement.stream))
      const streamInterrupted = Exit.hasInterrupts(settlement.stream)
      const tools = classifyToolExits(settlement.tools)

      if (overflowFailure) yield* publisher.publish(overflowFailure)
      const recorded = publisher.record()
      const unknownFinish =
        Exit.isSuccess(settlement.stream) && recorded.finish?.finish === "unknown"
          ? new AIError({
              reason: new InvalidProviderOutputError({
                message: "The provider response ended with an unknown finish reason.",
                classification: "incomplete-stream",
              }),
            })
          : undefined
      const llmFailure = streamFailure instanceof AIError ? streamFailure : unknownFinish
      const llmError = llmFailure && !recorded.providerFailed ? toSessionError(llmFailure) : undefined
      if (
        input.recoverContinuation &&
        llmFailure?.reason._tag === "Transport" &&
        (llmFailure.reason.recovery === "retry-full" || llmFailure.reason.recovery === "rotate-and-retry-full") &&
        !recorded.outputStarted
      )
        return Outcome.RecoverFull()
      if (llmFailure && llmError && SessionRunnerRetry.isRetryable(llmFailure) && !recorded.outputStarted) {
        yield* publisher.startAssistant()
        return Outcome.Retry({ cause: llmFailure, error: llmError })
      }
      if (llmError) yield* publisher.failAssistant(llmError)

      for (const decline of tools.declines)
        yield* publisher.failTool(decline.call.id, {
          type: "aborted",
          message:
            decline.reason._tag === "QuestionTool.CancelledError"
              ? decline.reason.message
              : "The user declined this tool call",
        })
      const interrupted = tools.declines.length > 0 || streamInterrupted || tools.interrupted
      const toolFailure = interrupted
        ? TOOLS_INTERRUPTED
        : tools.failure !== undefined
          ? toSessionError(Cause.squash(tools.failure))
          : recorded.providerFailed
            ? TOOLS_INTERRUPTED
            : undefined
      if (toolFailure) yield* publisher.failUnsettledTools(toolFailure)
      if (interrupted) yield* publisher.failAssistant(STEP_INTERRUPTED)

      if (llmError || (Exit.isSuccess(settlement.stream) && !recorded.providerFailed)) {
        const missing = yield* publisher.failUnsettledTools(RESULT_MISSING, "hosted")
        if (missing && !llmError && !recorded.finish) yield* publisher.failAssistant(RESULT_MISSING)
      }

      const record = publisher.record()
      if (record.finish || record.failure) {
        const snapshot = yield* snapshots.capture()
        const files =
          startSnapshot && snapshot
            ? startSnapshot === snapshot
              ? []
              : yield* snapshots
                  .files({ from: startSnapshot, to: snapshot })
                  .pipe(Effect.orElseSucceed(() => undefined))
            : undefined
        const usage = record.finish
          ? {
              cost: SessionUsage.calculateCost(input.model.cost, record.finish.tokens),
              tokens: record.finish.tokens,
            }
          : undefined
        if (record.failure) yield* publisher.publishStepFailure({ ...usage, snapshot, files })
        if (record.finish && usage && !record.failure)
          yield* bus.publish(SessionEvent.Step.Ended, {
            sessionID: input.sessionID,
            assistantMessageID: yield* publisher.startAssistant(),
            finish: record.finish.finish,
            rawFinish: record.finish.rawFinish,
            providerState: record.finish.providerState,
            ...usage,
            snapshot,
            files,
          })
      }

      // After durable output, recovery continues instead of replaying: the
      // partial assistant message is already persisted history. Any failure
      // the pre-output gate would retry is continued here, plus interrupted
      // streams, whose read failures may carry delivery states the retry
      // policy rejects for full resends.
      if (
        llmFailure &&
        llmError &&
        (isInterruptedStream(llmFailure) || SessionRunnerRetry.isRetryable(llmFailure)) &&
        record.outputStarted &&
        tools.declines.length === 0 &&
        !tools.interrupted
      )
        return Outcome.Continue({ cause: llmFailure, error: llmError })

      if (Exit.isFailure(settlement.stream)) return yield* Effect.failCause(settlement.stream.cause)
      if (tools.declines.length > 0) return yield* Effect.interrupt
      if (tools.interrupted && tools.failure) return yield* Effect.failCause(tools.failure)
      if (record.failure) return yield* new StepFailedError({ error: record.failure })
      return Outcome.Completed({
        needsContinuation: input.prepared.request.toolChoice?.type !== "none" && record.needsContinuation,
      })
    }, Effect.uninterruptible)

    return {
      observeUntilBoundary,
      runTool,
      finishProvider,
      recoverOverflow,
      settle,
    } satisfies Attempt
  })

  return { open }
})

const isInterruptedStream = (failure: AIError) => {
  if (failure.reason._tag === "InvalidProviderOutput") return failure.reason.classification === "incomplete-stream"
  if (failure.reason._tag === "Transport") return failure.reason.operation === "read"
  return false
}

/** Tool.Error settles in each fiber; only user declines remain in the typed error channel. */
const classifyToolExits = (
  runs: ReadonlyArray<{
    readonly call: ToolCall
    readonly exit: ToolExit
  }>,
) => {
  const declines = runs.flatMap((run) =>
    Exit.isFailure(run.exit)
      ? run.exit.cause.reasons.flatMap((reason) =>
          Cause.isFailReason(reason) ? [{ call: run.call, reason: reason.error }] : [],
        )
      : [],
  )
  const causes = runs.flatMap((run) => (Exit.isFailure(run.exit) ? [run.exit.cause] : []))
  const failure = causes
    .flatMap((cause) => {
      if (Cause.hasInterrupts(cause)) return []
      const reasons = cause.reasons.filter(Cause.isDieReason)
      return reasons.length > 0 ? [Cause.fromReasons<never>(reasons)] : []
    })
    .at(0)
  return { interrupted: causes.some(Cause.hasInterrupts), declines, failure }
}
