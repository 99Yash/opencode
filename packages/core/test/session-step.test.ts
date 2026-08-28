import { expect } from "bun:test"
import { AIError, LanguageModel, LLM, LLMEvent, TransportError } from "@opencode-ai/ai"
import { OpenAIChat } from "@opencode-ai/ai/protocols/openai-chat"
import { TestLLM } from "@opencode-ai/ai/testing"
import { Agent } from "@opencode-ai/core/agent"
import { Bus } from "@opencode-ai/core/bus"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { EventTable } from "@opencode-ai/core/event/sql"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath, RelativePath } from "@opencode-ai/core/schema"
import { Session } from "@opencode-ai/core/session"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { SessionStep } from "@opencode-ai/core/session/runner/step"
import { SessionStepMachine } from "@opencode-ai/core/session/runner/step-machine"
import { SessionMessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { Snapshot } from "@opencode-ai/core/snapshot"
import { ToolOutput } from "@opencode-ai/core/tool-output"
import { Money } from "@opencode-ai/schema/money"
import { LayerNode } from "@opencode-ai/util/effect/layer-node"
import { asc, eq } from "drizzle-orm"
import { Deferred, Effect, Exit, Fiber, Layer, Stream } from "effect"
import { testEffect } from "./lib/effect"

const it = testEffect(
  Layer.merge(
    AppNodeBuilder.build(LayerNode.group([Database.node, Bus.node, SessionProjector.node, ToolOutput.node]), [
      [Bus.node, Bus.configured({ persist: true })],
    ]),
    TestLLM.testLayer(),
  ),
)

for (const fixture of [
  { finish: "stop", toolChoice: undefined },
  { finish: "content-filter", toolChoice: undefined },
  { finish: "stop", toolChoice: "none" },
] as const) {
  it.effect(`settles ${fixture.finish} with tool choice ${fixture.toolChoice ?? "default"}`, () =>
    Effect.gen(function* () {
      const start = Snapshot.ID.make("before")
      const end = Snapshot.ID.make("after")
      const files = [RelativePath.make("changed.ts")]
      let captures = 0
      let executions = 0
      const s = yield* setup({
        snapshot: {
          capture: () => Effect.sync(() => (captures++ === 0 ? start : end)),
          files: (input) => {
            expect(input).toEqual({ from: start, to: end })
            return Effect.succeed(files)
          },
        },
      })
      yield* s.llm.push(
        TestLLM.complete(
          {
            reason: { normalized: fixture.finish },
            usage: {
              inputTokens: 15,
              outputTokens: 6,
              nonCachedInputTokens: 10,
              cacheReadInputTokens: 3,
              cacheWriteInputTokens: 2,
              reasoningTokens: 2,
            },
          },
          LLMEvent.toolCall({ id: "call-test", name: "test", input: {} }),
        ),
      )
      const result = yield* SessionStepMachine.run(s.assistantMessageID, {
        prepare: (context) =>
          s.prepare(context, {
            toolChoice: fixture.toolChoice,
            executeTool: () =>
              Effect.sync(() => {
                executions++
                return { content: "Completed tool" }
              }),
          }),
        retry: () => Effect.die("Unexpected retry"),
        publishSynthetic: Effect.die("Unexpected continuation"),
      }).pipe(Effect.exit)
      expect(Exit.isSuccess(result)).toBe(fixture.finish === "stop")
      expect(executions).toBe(fixture.toolChoice === "none" ? 0 : 1)
      if (Exit.isSuccess(result)) expect(result.value).toBe(fixture.toolChoice !== "none")
      expect(yield* s.llm.requests()).toHaveLength(1)
      expect(captures).toBe(2)
      const message = yield* s.message
      expect(message).toMatchObject({
        finish: fixture.finish,
        tokens: { input: 10, output: 4, reasoning: 2, cache: { read: 3, write: 2 } },
        snapshot: { start, end, files },
        content: [{ type: "tool", state: { status: fixture.toolChoice === "none" ? "error" : "completed" } }],
      })
      expect(message).toHaveProperty("cost", expect.closeTo(0.0000233, 10))
      const types = yield* s.events
      const terminal = fixture.finish === "stop" ? "session.step.ended.1" : "session.step.failed.1"
      expect(types.filter((type) => type === terminal)).toHaveLength(1)
      expect(
        types.indexOf(fixture.toolChoice === "none" ? "session.tool.failed.2" : "session.tool.success.2"),
      ).toBeLessThan(types.indexOf(terminal))
    }),
  )
}

it.effect("closes provider stream resources before the next physical retry", () =>
  Effect.gen(function* () {
    const s = yield* setup()
    const cleanupStarted = yield* Deferred.make<void>()
    const cleanupRelease = yield* Deferred.make<void>()
    const operations: string[] = []
    yield* s.llm.push(
      Stream.unwrap(
        Effect.acquireRelease(
          Effect.sync(() => operations.push("acquire")),
          () =>
            Deferred.succeed(cleanupStarted, undefined).pipe(
              Effect.andThen(Deferred.await(cleanupRelease)),
              Effect.andThen(Effect.sync(() => operations.push("release"))),
            ),
        ).pipe(
          Effect.as(
            Stream.fail(
              new AIError({
                reason: new TransportError({ message: "Request failed", transport: "http", operation: "request" }),
              }),
            ),
          ),
        ),
      ),
      TestLLM.stop(),
    )
    const run = yield* SessionStepMachine.run(s.assistantMessageID, {
      prepare: (context) => Effect.sync(() => operations.push("prepare")).pipe(Effect.andThen(s.prepare(context))),
      retry: () => Effect.sync(() => operations.push("retry")).pipe(Effect.asVoid),
      publishSynthetic: Effect.die("Unexpected continuation"),
    }).pipe(Effect.forkScoped({ startImmediately: true }))
    yield* Effect.addFinalizer(() => Deferred.succeed(cleanupRelease, undefined))
    yield* Deferred.await(cleanupStarted)

    expect(operations).toEqual(["prepare", "acquire"])
    expect(yield* s.llm.requests()).toHaveLength(1)
    expect(run.pollUnsafe()).toBeUndefined()
    yield* Deferred.succeed(cleanupRelease, undefined)
    expect(yield* Fiber.join(run)).toBe(false)
    expect(operations).toEqual(["prepare", "acquire", "release", "retry", "prepare"])
    expect(yield* s.llm.requests()).toHaveLength(2)
    expect(yield* s.message).toMatchObject({ finish: "stop" })
  }),
)

for (const providerExecuted of [false, true]) {
  it.effect(
    `commits ${providerExecuted ? "provider-hosted" : "local"} tool success during cancellation under the bus lock`,
    () =>
      Effect.gen(function* () {
        const ready = yield* Deferred.make<void>()
        const resultRelease = yield* Deferred.make<void>()
        const publishing = yield* Deferred.make<void>()
        const held = yield* Deferred.make<void>()
        const lockRelease = yield* Deferred.make<void>()
        const s = yield* setup({
          observePublish: (type) =>
            type === SessionEvent.Tool.Success.type ? Deferred.succeed(publishing, undefined) : Effect.void,
        })
        const call = LLMEvent.toolCall({ id: "call-race", name: "lookup", input: {}, providerExecuted })
        let executions = 0
        yield* s.llm.push(
          providerExecuted
            ? Stream.fromIterable([LLMEvent.stepStart({ index: 0 }), call]).pipe(
                Stream.concat(
                  Stream.unwrap(
                    Deferred.succeed(ready, undefined).pipe(
                      Effect.andThen(Deferred.await(resultRelease)),
                      Effect.as(
                        Stream.make(
                          LLMEvent.toolResult({
                            id: call.id,
                            name: call.name,
                            providerExecuted: true,
                            result: { type: "text", value: "Durable result" },
                          }),
                        ),
                      ),
                    ),
                  ),
                ),
                Stream.concat(Stream.never),
              )
            : TestLLM.hangAfter(LLMEvent.stepStart({ index: 0 }), call),
        )
        const run = yield* SessionStepMachine.run(s.assistantMessageID, {
          prepare: (context) =>
            s.prepare(context, {
              executeTool: () =>
                Effect.gen(function* () {
                  executions++
                  yield* Deferred.succeed(ready, undefined)
                  yield* Deferred.await(resultRelease)
                  return { content: "Durable result" }
                }),
            }),
          retry: () => Effect.die("Unexpected retry"),
          publishSynthetic: Effect.die("Unexpected continuation"),
        }).pipe(Effect.forkScoped({ startImmediately: true }))
        yield* Deferred.await(ready)
        yield* Effect.acquireRelease(
          s.bus.listen((event) =>
            event.type === SessionEvent.Renamed.type
              ? Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(lockRelease)))
              : Effect.void,
          ),
          (unsubscribe) => unsubscribe,
        )
        // Notifications hold the real aggregate lock after the unrelated event commits.
        const holder = yield* s.bus
          .publish(SessionEvent.Renamed, { sessionID: s.sessionID, title: "Hold publication" })
          .pipe(Effect.forkScoped({ startImmediately: true }))
        yield* Effect.addFinalizer(() => Deferred.succeed(lockRelease, undefined))
        yield* Deferred.await(held)
        yield* Deferred.succeed(resultRelease, undefined)
        yield* Deferred.await(publishing)
        const cancellation = yield* Fiber.interrupt(run).pipe(Effect.forkChild({ startImmediately: true }))
        yield* Effect.yieldNow

        expect(cancellation.pollUnsafe()).toBeUndefined()
        expect(yield* s.events).not.toContain("session.tool.success.2")
        yield* Deferred.succeed(lockRelease, undefined)
        yield* Fiber.join(holder)
        yield* Fiber.join(cancellation)
        expect(Exit.hasInterrupts(yield* Fiber.await(run))).toBe(true)
        expect(executions).toBe(providerExecuted ? 0 : 1)
        expect(yield* s.llm.requests()).toHaveLength(1)
        const events = yield* s.events
        expect(events.filter((type) => type === "session.tool.success.2")).toHaveLength(1)
        expect(events).not.toContain("session.tool.failed.2")
        expect(events.filter((type) => type === "session.step.failed.1")).toHaveLength(1)
        expect(events.indexOf("session.tool.success.2")).toBeLessThan(events.indexOf("session.step.failed.1"))
        expect(yield* s.message).toMatchObject({
          finish: "error",
          error: { type: "aborted" },
          content: [
            {
              type: "tool",
              id: call.id,
              executed: providerExecuted,
              state: { status: "completed", content: [{ type: "text", text: "Durable result" }] },
            },
          ],
        })
      }),
  )
}

it.effect("recovers overflow instead of generically retrying a subsequent transport failure", () =>
  Effect.gen(function* () {
    const s = yield* setup()
    const contexts: SessionStepMachine.Context[] = []
    const operations: string[] = []
    yield* s.llm.push(
      TestLLM.failAfter(
        new AIError({
          reason: new TransportError({ message: "Read failed", transport: "http", operation: "read" }),
        }),
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.providerError({ message: "Prompt too long", classification: "context-overflow" }),
      ),
      TestLLM.stop(),
    )
    const result = yield* SessionStepMachine.run(s.assistantMessageID, {
      prepare: (context) =>
        Effect.sync(() => contexts.push(context)).pipe(
          Effect.andThen(
            s.prepare(context, {
              recoverOverflow: Effect.sync(() => {
                operations.push("compact")
                return true
              }),
            }),
          ),
        ),
      retry: () => Effect.sync(() => operations.push("retry")).pipe(Effect.asVoid),
      publishSynthetic: Effect.die("Unexpected continuation"),
    })

    expect(result).toBe(false)
    expect(operations).toEqual(["compact"])
    expect(yield* s.llm.requests()).toHaveLength(2)
    expect(contexts).toHaveLength(2)
    expect(contexts[0]).toMatchObject({ assistantMessageID: s.assistantMessageID, recoverOverflow: true })
    expect(contexts[1]).toMatchObject({ recoverOverflow: false })
    expect(contexts[1]?.assistantMessageID).not.toBe(s.assistantMessageID)
    expect(yield* s.events).not.toContain("session.step.failed.1")
  }),
)

const setup = Effect.fnUntraced(function* (
  options: {
    readonly snapshot?: Pick<Snapshot.Interface, "capture" | "files">
    readonly observePublish?: (type: string) => Effect.Effect<unknown>
  } = {},
) {
  const db = (yield* Database.Service).db
  const bus = yield* Bus.Service
  const llm = yield* TestLLM.Test
  const sessionID = Session.ID.create()
  const assistantMessageID = SessionMessage.ID.create()
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .run()
  yield* db
    .insert(SessionTable)
    .values({ id: sessionID, project_id: Project.ID.global, slug: "step", directory: "/project", version: "test" })
    .run()
  const model = SessionRunnerModel.resolved(
    LanguageModel.make({ id: "test-model", provider: "test", route: OpenAIChat.route }),
    {
      capabilities: { tools: true, input: ["text"], output: ["text"] },
      limit: { context: 100_000, output: 1_000 },
      cost: [
        {
          input: Money.USDPerMillionTokens.make(1),
          output: Money.USDPerMillionTokens.make(2),
          cache: { read: Money.USDPerMillionTokens.make(0.1), write: Money.USDPerMillionTokens.make(0.5) },
        },
      ],
    },
  )
  const steps = yield* SessionStep.make.pipe(
    Effect.provide(
      Layer.mock(Snapshot.Service)(
        options.snapshot ?? { capture: () => Effect.undefined, files: () => Effect.succeed([]) },
      ),
    ),
    Effect.provideService(Bus.Service, {
      ...bus,
      publish: (definition, data, publishOptions) =>
        (options.observePublish?.(definition.type) ?? Effect.void).pipe(
          Effect.andThen(bus.publish(definition, data, publishOptions)),
        ),
    }),
  )
  return {
    bus,
    llm,
    sessionID,
    assistantMessageID,
    prepare: (
      context: SessionStepMachine.Context,
      input?: {
        readonly toolChoice?: "none"
        readonly executeTool?: SessionStep.Input["prepared"]["executeTool"]
        readonly recoverOverflow?: Effect.Effect<boolean>
      },
    ) =>
      steps
        .open({
          sessionID,
          assistantMessageID: context.assistantMessageID,
          agent: Agent.defaultID,
          model,
          prepared: {
            request: LLM.request({ model: model.model, prompt: "Run one step", toolChoice: input?.toolChoice }),
            options: {},
            executeTool: input?.executeTool ?? (() => Effect.die("Unexpected tool execution")),
          },
          recoverContinuation: context.recoverContinuation,
          recoverOverflow: input?.recoverOverflow ?? Effect.succeed(false),
        })
        .pipe(Effect.map((attempt) => SessionStepMachine.Preparation.Ready({ attempt }))),
    message: db
      .select()
      .from(SessionMessageTable)
      .where(eq(SessionMessageTable.id, assistantMessageID))
      .get()
      .pipe(Effect.map((row) => row?.data)),
    events: db
      .select({ type: EventTable.type })
      .from(EventTable)
      .where(eq(EventTable.aggregate_id, sessionID))
      .orderBy(asc(EventTable.seq))
      .all()
      .pipe(Effect.map((rows) => rows.map((row) => row.type))),
  }
})
