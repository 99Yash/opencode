export * as SessionStep from "./step.js"

import { Message } from "@opencode-ai/ai"
import { Effect, Pull, Schedule } from "effect"
import { Bus } from "../../bus.js"
import { SessionCompaction } from "../compaction.js"
import { SessionContext } from "../context.js"
import { StepFailedError } from "../error.js"
import { SessionEvent } from "../event.js"
import { SessionMessage } from "../message.js"
import { SessionModelRequest } from "../model-request.js"
import { SessionAttempt } from "./attempt.js"
import { MAX_STEPS_PROMPT } from "./max-steps.js"
import { SessionRunnerRetry } from "./retry.js"

const CONTINUE_AFTER_INCOMPLETE_STREAM =
  "The previous response was interrupted. Continue from where you left off without repeating completed content."

/** A logical Step owns request preparation and recovery, without promoting inbox input. */
export const make = Effect.gen(function* () {
  const bus = yield* Bus.Service
  const context = yield* SessionContext.Service
  const compaction = yield* SessionCompaction.Service
  const attempts = yield* SessionAttempt.make

  const run = Effect.fn("SessionStep.run")(function* (input: {
    readonly first: SessionContext.Loaded
    readonly number: number
  }) {
    const sessionID = input.first.session.id
    let assistantMessageID = SessionMessage.ID.create()
    const retry = yield* Schedule.toStepWithSleep(SessionRunnerRetry.schedule(bus, sessionID))
    let initial: SessionContext.Loaded | undefined = input.first
    let recoverOverflow = true
    let recoverContinuation = true
    while (true) {
      // Reuse boundary preparation once; retries refresh context without delivering more input.
      const loaded = initial ?? (yield* context.preflight(sessionID).pipe(Effect.flatMap(context.load)))
      initial = undefined
      const compactionInput = {
        session: loaded.session,
        messages: loaded.messages,
        resolved: loaded.model,
        prepare: context.prepare,
      }
      if (compaction.required(compactionInput)) {
        const compacted = yield* compaction.compact(compactionInput)
        if (compacted.status !== "completed") return yield* new StepFailedError({ error: compacted.error })
        assistantMessageID = SessionMessage.ID.create()
        continue
      }
      const stepLimitReached = loaded.agent.info.steps !== undefined && input.number >= loaded.agent.info.steps
      const transcript = SessionModelRequest.baseTranscript({
        agent: loaded.agent.info,
        model: loaded.model,
        tools: loaded.tools,
        initial: loaded.initial,
        messages: loaded.messages,
      })
      const prepared = yield* context.prepare({
        scope: { session: loaded.session, agentID: loaded.agent.id, model: loaded.model, tools: loaded.tools },
        transcript: {
          system: transcript.system,
          messages: stepLimitReached
            ? [...transcript.messages, Message.assistant(MAX_STEPS_PROMPT)]
            : transcript.messages,
        },
        // Keep tool definitions on the final Step to preserve the provider's cached prefix.
        toolChoice: stepLimitReached ? "none" : undefined,
        webSocket: "session",
      })
      const outcome = yield* attempts.use(
        {
          sessionID,
          assistantMessageID,
          agent: loaded.agent.id,
          model: loaded.model,
          prepared,
        },
        (result, restore) =>
          Effect.gen(function* () {
            if (result.outputStarted) return undefined
            // The attempt retains its pending terminal while interruptible summarization runs.
            if (result.overflowBeforeOutput) {
              // Even skipped recovery must observe pending interruption before publishing the held error.
              const compacted = yield* restore(
                recoverOverflow && compaction.enabled()
                  ? compaction.compact(compactionInput).pipe(Effect.map((result) => result.status === "completed"))
                  : Effect.succeed(false),
              )
              if (compacted) return SessionAttempt.Outcome.Compacted()
            }
            if (
              recoverContinuation &&
              result.failure?.reason._tag === "Transport" &&
              (result.failure.reason.recovery === "retry-full" ||
                result.failure.reason.recovery === "rotate-and-retry-full")
            )
              return SessionAttempt.Outcome.RecoverFull()
            if (result.failure && result.error && SessionRunnerRetry.isRetryable(result.failure))
              return SessionAttempt.Outcome.Retry({ cause: result.failure, error: result.error })
            return undefined
          }),
      )
      switch (outcome._tag) {
        case "Completed":
          return outcome.needsContinuation
        case "Retry":
          yield* retry({ cause: outcome.cause, error: outcome.error, assistantMessageID }).pipe(
            Pull.catchDone(() =>
              bus
                .publish(SessionEvent.Step.Failed, { sessionID, assistantMessageID, error: outcome.error })
                .pipe(Effect.andThen(outcome.cause)),
            ),
          )
          continue
        case "Continue":
          // The partial span is already settled; share backoff before committing continuation.
          yield* retry({ cause: outcome.cause, error: outcome.error, assistantMessageID }).pipe(
            Pull.catchDone(() => outcome.cause),
          )
          yield* bus.publish(SessionEvent.Synthetic, { sessionID, text: CONTINUE_AFTER_INCOMPLETE_STREAM })
          assistantMessageID = SessionMessage.ID.create()
          continue
        case "Compacted":
          recoverOverflow = false
          assistantMessageID = SessionMessage.ID.create()
          continue
        case "RecoverFull":
          recoverContinuation = false
          continue
      }
    }
  })

  return { run }
})
