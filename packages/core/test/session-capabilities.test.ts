import { describe, expect } from "bun:test"
import { LanguageModel } from "@opencode-ai/ai"
import { OpenAIChat } from "@opencode-ai/ai/protocols/openai-chat"
import { TestLLM } from "@opencode-ai/ai/testing"
import { Context, Deferred, Effect, Exit, Fiber, Layer, RcMap, Scope } from "effect"
import { eq } from "drizzle-orm"
import { LayerNode } from "@opencode-ai/util/effect/layer-node"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNodePlatform } from "../src/effect/app-node-platform"
import { Bus } from "../src/bus"
import { Database } from "../src/database/database"
import { Instructions } from "../src/instructions/index"
import { KV } from "../src/kv"
import { Session } from "../src/session"
import { InstructionState } from "../src/session/instruction-state"
import { SessionResolve } from "../src/session/resolve"
import { SessionRunnerModel } from "../src/session/runner/model"
import { InstructionBlobTable, InstructionStateTable, SessionTable } from "../src/session/sql"
import { SessionStore } from "../src/session/store"
import { Source } from "../src/source"
import { SessionRestart } from "../src/session/execution/restart"
import { Location } from "../src/location"
import { AbsolutePath } from "../src/schema"
import { InstructionEntry } from "../src/session/instruction-entry"
import { Tool } from "../src/tool"
import { testEffect } from "./lib/effect"
import { tmpdir } from "./fixture/tmpdir"
import path from "path"
import { LocationServiceMap } from "../src/location-service-map"
import { Skill } from "../src/skill"
import { Permissions } from "../src/permissions"
import { Permission } from "../src/permission"
import { SessionMessage } from "../src/session/message"
import { PluginHooks } from "../src/plugin/hooks"
import { echo } from "./fixture/capabilities"
import { App } from "../src/app"
import { SessionExecution } from "../src/session/execution"

const scripted = TestLLM.layer()
const application = AppNodeBuilder.build(
  LayerNode.group([
    Session.node,
    SessionExecution.node,
    LocationServiceMap.node,
    SessionResolve.node,
    SessionStore.node,
    SessionRestart.node,
    Database.node,
    Bus.node,
    KV.node,
    InstructionEntry.node,
    PluginHooks.node,
  ]),
  [
    [App.node, App.configured({ name: "fixture-host" })],
    [Bus.node, Bus.configured({ persist: true })],
    [LayerNodePlatform.llmClient, TestLLM.clientLayer.pipe(Layer.provide(scripted))],
  ],
).pipe(Layer.provideMerge(scripted))
const it = testEffect(application)
const isolated = testEffect(scripted)
const model = SessionRunnerModel.resolved(
  LanguageModel.make({ id: "fixture-model", provider: "fixture", route: OpenAIChat.route }),
  {
    capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
    cost: [],
    limit: { context: 200_000, output: 32_000 },
  },
)

describe("Session capabilities", () => {
  it.live("closing a replacement during retirement leaves late admitted work parked", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const llm = yield* TestLLM.Service
      const locations = yield* LocationServiceMap.Service
      const retiring = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined))
      const gate = yield* llm.gate
      const session = yield* sessions.open({
        model,
        retire: () => Deferred.succeed(retiring, undefined).pipe(Effect.andThen(Deferred.await(release))),
      })
      yield* llm.push(TestLLM.text("first done", "late_close_reply"))
      const running = yield* session.prompt({ text: "First busy period." }).pipe(Effect.forkScoped)
      yield* llm.wait(1)
      const replacement = yield* sessions.open({ id: session.id, model })
      yield* gate.release
      yield* Deferred.await(retiring)
      yield* sessions.prompt({ sessionID: session.id, text: "Late work." })
      yield* replacement.close()
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(running)
      yield* sessions.wait(session.id)
      expect(Array.from(yield* RcMap.keys(locations.rcMap))).toEqual([])
      expect(yield* sessions.inbox(session.id)).toHaveLength(1)
      expect(llm.requests).toHaveLength(1)
      const reopened = yield* sessions.open({ id: session.id, model })
      yield* llm.push(TestLLM.text("late work drained", "late_reopened_reply"))
      // An advisory wake after reopen delivers the already-admitted item, without a new prompt.
      const execution = yield* SessionExecution.Service
      yield* execution.wake(reopened.id)
      yield* sessions.wait(reopened.id)
      expect(yield* sessions.inbox(reopened.id)).toHaveLength(0)
      expect(llm.requests).toHaveLength(2)
      expect(JSON.stringify(llm.requests[1].messages)).toContain("Late work.")
      expect(Array.from(yield* RcMap.keys(locations.rcMap))).toEqual([])
    }),
  )

  it.live("failed durable ownership writes do not poison the memory index", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const resolve = yield* SessionResolve.Service
      const store = yield* SessionStore.Service
      const db = (yield* Database.Service).db
      const id = Session.ID.make("ses_rejected_marker")
      yield* db
        .run("CREATE TRIGGER reject_marker BEFORE INSERT ON kv BEGIN SELECT RAISE(ABORT, 'marker rejected'); END")
        .pipe(Effect.orDie)
      const exit = yield* sessions
        .open({ id, model })
        .pipe(Effect.exit, Effect.ensuring(db.run("DROP TRIGGER reject_marker").pipe(Effect.orDie)))
      expect(exit._tag).toBe("Failure")
      expect(yield* store.get(id)).toBeUndefined()
      expect(resolve.status(id)).toBe("unowned")
      const session = yield* sessions.open({ id, model })
      expect(resolve.status(id)).toBe("attached")
      yield* session.close()
    }),
  )

  it.live("pins at coordinator start before a close can retire the new busy period", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const execution = yield* SessionExecution.Service
      const resolve = yield* SessionResolve.Service
      const llm = yield* TestLLM.Service
      const session = yield* sessions.open({ model })
      yield* session.prompt({ text: "Begin before close.", resume: false })
      yield* llm.push(TestLLM.text("settled", "start_close_reply"))
      const running = yield* execution.resume(session.id).pipe(Effect.forkScoped({ startImmediately: true }))
      expect((yield* execution.active).has(session.id)).toBe(true)
      const closing = yield* session.close().pipe(Effect.forkScoped({ startImmediately: true }))
      expect(resolve.status(session.id)).toBe("owned-detached")
      yield* Fiber.join(running)
      yield* Fiber.join(closing)
      expect(llm.requests).toHaveLength(1)
    }),
  )

  it.live("close waits for busy-period settlement, preserves history, and cannot close a replacement", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const resolve = yield* SessionResolve.Service
      const llm = yield* TestLLM.Service
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const retired: string[] = []
      const session = yield* sessions.open({
        model,
        tools: [
          echo((text) =>
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.as(text),
              Effect.ensuring(
                Effect.sync(() => {
                  retired.push("tool")
                }),
              ),
            ),
          ),
        ],
        retire: () =>
          Effect.sync(() => {
            retired.push("old")
          }),
      })
      yield* llm.push(
        TestLLM.tool("close_tool", "execute", { code: 'return await tools.echo({ text: "settled" })' }),
        TestLLM.text("settled", "close_reply"),
      )
      const prompting = yield* session.prompt({ text: "Work before close." }).pipe(Effect.forkScoped)
      yield* Deferred.await(started)
      const closing = yield* session.close().pipe(Effect.forkScoped({ startImmediately: true }))
      expect(resolve.status(session.id)).toBe("owned-detached")
      expect(retired).toEqual([])
      expect(llm.requests).toHaveLength(1)
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(prompting)
      yield* Fiber.join(closing)
      expect(retired).toEqual(["tool", "old"])
      expect(llm.requests).toHaveLength(2)
      expect(yield* sessions.messages({ sessionID: session.id })).toHaveLength(3)
      expect((yield* session.resume().pipe(Effect.exit)).toString()).toContain("must be reopened with capabilities")
      expect(llm.requests).toHaveLength(2)
      const reopened = yield* sessions.open({
        id: session.id,
        model,
        retire: () =>
          Effect.sync(() => {
            retired.push("new")
          }),
      })
      yield* session.close()
      expect(resolve.status(session.id)).toBe("attached")
      yield* reopened.close()
      yield* reopened.close()
      expect(retired).toEqual(["tool", "old", "new"])
      expect(resolve.status(session.id)).toBe("owned-detached")
    }),
  )

  it.live("cached snapshots skip rebuilding but reread all selection capabilities", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const resolve = yield* SessionResolve.Service
      const entries = yield* InstructionEntry.Service
      const tools = Source.mutable([echo(Effect.succeed)])
      const rules = Source.mutable<Permission.Ruleset>([{ action: "*", resource: "*", effect: "allow" }])
      const counts = { tools: 0, rules: 0, limits: 0 }
      const session = yield* sessions.open({
        model,
        tools: {
          get: (session) =>
            Effect.sync(() => {
              counts.tools++
            }).pipe(Effect.andThen(tools.get(session))),
        },
        permissions: {
          ask: Permissions.allowAll.ask,
          visibility: {
            get: (session) =>
              Effect.sync(() => {
                counts.rules++
              }).pipe(Effect.andThen(rules.get(session))),
          },
        },
        limits: { get: () => Effect.sync(() => ({ steps: ++counts.limits })) },
      })
      const resolved = yield* resolve.resolve(yield* sessions.get(session.id))
      if (resolved.status !== "attached") return yield* Effect.die("Expected open capabilities")
      const first = yield* resolved.capabilities.select(session.id)
      yield* entries.put({ sessionID: session.id, key: InstructionEntry.Key.make("cache-proof"), value: "Fresh entry" })
      const second = yield* resolved.capabilities.select(session.id)
      expect(second.tools).toBe(first.tools)
      expect(second.agent.info.steps).toBe(2)
      expect(second.instructions.map((source) => source.key)).toContain(Instructions.Key.make("api/cache-proof"))
      expect(counts).toEqual({ tools: 2, rules: 2, limits: 2 })
      const original = yield* tools.get(first.session)
      yield* tools.set([...original])
      const replaced = yield* resolved.capabilities.select(session.id)
      expect(replaced.tools).not.toBe(first.tools)
      yield* tools.set(original)
      const restored = yield* resolved.capabilities.select(session.id)
      expect(restored.tools).not.toBe(first.tools)
      expect(restored.tools).not.toBe(replaced.tools)
      yield* rules.update((rules) => [...rules])
      const repolicy = yield* resolved.capabilities.select(session.id)
      expect(repolicy.tools).not.toBe(restored.tools)
      expect(counts).toEqual({ tools: 5, rules: 5, limits: 5 })
    }),
  )

  it.live("reopens already-owned Sessions without rewriting KV and skips unowned removal", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const resolve = yield* SessionResolve.Service
      const db = (yield* Database.Service).db
      const session = yield* sessions.open({ model })
      yield* db.run("PRAGMA query_only = ON").pipe(Effect.orDie)
      yield* Effect.gen(function* () {
        yield* sessions.open({ id: session.id, model })
        yield* resolve.remove(Session.ID.make("ses_unowned_removal"))
        expect(resolve.status(session.id)).toBe("attached")
      }).pipe(Effect.ensuring(db.run("PRAGMA query_only = OFF").pipe(Effect.orDie)))
    }),
  )

  it.live("fresh local defaults do not inherit plugin state from the host's root composition", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const hooks = yield* PluginHooks.Service
      const llm = yield* TestLLM.Service
      const executed: string[] = []
      yield* hooks.register(
        "tool",
        "execute.before",
        () => new Tool.Error({ message: "Root plugin rejected execution" }),
      )
      yield* hooks.register("session", "prompt", (event) =>
        Effect.sync(() => {
          event.prompt.text = "Root prompt interceptor must not reach supplied capabilities"
        }),
      )
      const session = yield* sessions.open({
        model,
        tools: [
          echo((text) =>
            Effect.sync(() => {
              executed.push(text)
              return text
            }),
          ),
        ],
      })
      yield* llm.push(
        TestLLM.tool("root_isolation", "execute", { code: 'return await tools.echo({ text: "local" })' }),
        TestLLM.text("finished", "root_isolation_reply"),
      )
      yield* session.prompt({ text: "Execute with local defaults." })
      expect(executed).toEqual(["local"])
      expect(JSON.stringify(llm.requests)).not.toContain("Root plugin rejected execution")
      expect(JSON.stringify(llm.requests)).not.toContain("Root prompt interceptor")
    }),
  )

  isolated.live("reconstructs over durable storage with zero model calls until reopen and explicit drive", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir("session-capabilities-")),
        (directory) => Effect.promise(() => directory[Symbol.asyncDispose]()),
      )
      const llm = yield* TestLLM.Service
      const root = AppNodeBuilder.build(
        LayerNode.group([
          Session.node,
          SessionResolve.node,
          SessionStore.node,
          SessionRestart.node,
          LocationServiceMap.node,
          Database.node,
        ]),
        [
          [Database.node, Database.configured({ path: path.join(directory.path, "sessions.db") })],
          [Bus.node, Bus.configured({ persist: true })],
          [LayerNodePlatform.llmClient, TestLLM.clientLayer.pipe(Layer.provide(Layer.succeed(TestLLM.Service, llm)))],
        ],
      )
      const firstScope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(firstScope, Exit.void))
      const first = yield* Layer.buildWithScope(Layer.fresh(root), firstScope)
      const sessions = Context.get(first, Session.Service)
      const input = { model, instructions: ["Persist across restarts."], tools: [echo(Effect.succeed)] }
      const session = yield* sessions.open(input)
      const initial = yield* sessions.get(session.id)
      // A process may die after open's durable writes, before admission or a claim.
      yield* Context.get(first, SessionRestart.Service).resumeSuspendedSessions
      expect(llm.requests).toHaveLength(0)
      expect(yield* Context.get(first, SessionStore.Service).listSuspended()).toEqual([])
      yield* session.prompt({ text: "Pending work.", resume: false })
      yield* Context.get(first, SessionStore.Service).claim(session.id)
      yield* Scope.close(firstScope, Exit.void)
      // Status and unowned cleanup must remain pure memory operations, even with storage closed.
      expect(Context.get(first, SessionResolve.Service).status(session.id)).toBe("owned-detached")
      expect(Context.get(first, SessionResolve.Service).status(Session.ID.make("ses_unknown"))).toBe("unowned")
      yield* Context.get(first, SessionResolve.Service).remove(Session.ID.make("ses_unknown"))

      const secondScope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(secondScope, Exit.void))
      const second = yield* Layer.buildWithScope(Layer.fresh(root), secondScope)
      const restarted = Context.get(second, Session.Service)
      const recovery = Context.get(second, SessionRestart.Service)
      const db = Context.get(second, Database.Service).db
      yield* recovery.resumeSuspendedSessions
      expect(llm.requests).toHaveLength(0)
      expect(yield* Context.get(second, SessionStore.Service).listSuspended()).toEqual([session.id])
      const waiting = yield* db
        .select()
        .from(SessionTable)
        .where(eq(SessionTable.id, session.id))
        .get()
        .pipe(Effect.orDie)
      expect(waiting?.time_suspended).not.toBeNull()
      expect(waiting?.resume_attempts).toBe(0)
      expect(Array.from(yield* RcMap.keys(Context.get(second, LocationServiceMap.Service).rcMap))).toEqual([])
      const reopened = yield* restarted.open({ ...input, id: session.id, title: "ignored" })
      expect((yield* restarted.get(session.id)).location).toEqual(initial.location)
      expect((yield* restarted.get(session.id)).projectID).toBe(initial.projectID)
      yield* recovery.resumeSuspendedSessions
      expect(llm.requests).toHaveLength(0)
      yield* llm.push(TestLLM.text("resumed", "recovery_reply"))
      yield* reopened.resume()
      expect(llm.requests).toHaveLength(1)
      expect(llm.requests[0].system.map((part) => part.text).join("\n")).toContain("Persist across restarts.")
      expect(yield* Context.get(second, SessionStore.Service).listSuspended()).toEqual([])
      expect(
        (yield* restarted.messages({ sessionID: session.id })).filter((message) => message.type === "assistant"),
      ).toHaveLength(1)
      expect(Array.from(yield* RcMap.keys(Context.get(second, LocationServiceMap.Service).rcMap))).toEqual([])
    }),
  )

  it.live("opens with values and drains through tools, durable history, and the instruction epoch", () =>
    Effect.gen(function* () {
      const llm = yield* TestLLM.Service
      const sessions = yield* Session.Service
      const db = (yield* Database.Service).db
      const kv = yield* KV.Service
      const executed: string[] = []
      const tools = Source.mutable([
        echo((text) =>
          Effect.sync(() => {
            executed.push(text)
            return text
          }),
        ),
      ])
      const session = yield* sessions.open({ model, tools, instructions: ["Keep replies brief."] })
      expect(llm.requests).toHaveLength(0)
      expect(yield* kv.get(`session.capabilities/${session.id}`)).toBe(true)
      const row = yield* db.select().from(SessionTable).where(eq(SessionTable.id, session.id)).get().pipe(Effect.orDie)
      expect(row?.time_suspended).toBeNull()
      yield* llm.push(
        TestLLM.tool("echo_call", "execute", { code: 'return await tools.echo({ text: "hello" })' }),
        TestLLM.text("done", "reply"),
      )
      yield* session.prompt({ text: "Use echo." })
      expect(executed).toEqual(["hello"])
      expect(llm.requests).toHaveLength(2)
      expect(llm.requests[0]?.tools.map((tool) => tool.name)).toEqual(["execute"])
      expect(llm.requests[0]?.http?.headers?.["x-opencode-client"]).toBe("fixture-host")
      expect(llm.requests[0]?.system.map((part) => part.text).join("\n")).toContain("Keep replies brief.")
      const history = yield* sessions.messages({ sessionID: session.id })
      expect(history.filter((message) => message.type === "user")).toHaveLength(1)
      expect(history.filter((message) => message.type === "assistant")).toHaveLength(2)
      expect(
        history.some(
          (message) =>
            message.type === "assistant" &&
            message.content.some((part) => part.type === "tool" && part.state.status === "completed"),
        ),
      ).toBe(true)
      const state = yield* db
        .select()
        .from(InstructionStateTable)
        .where(eq(InstructionStateTable.session_id, session.id))
        .get()
        .pipe(Effect.orDie)
      expect(state?.initial_values["session/instructions"]).toBe(Instructions.hash(["Keep replies brief."]))
      expect(state?.current_values).toEqual(state?.initial_values)
      const blob = yield* db
        .select()
        .from(InstructionBlobTable)
        .where(eq(InstructionBlobTable.hash, Instructions.hash(["Keep replies brief."])))
        .get()
        .pipe(Effect.orDie)
      expect(blob?.value).toEqual(["Keep replies brief."])
    }),
  )

  it.live("admits images without discovery and rejects undiscovered skill mentions as missing", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const llm = yield* TestLLM.Service
      const session = yield* sessions.open({ model })
      const admitted = yield* session.prompt({
        text: "Inspect this image.",
        files: [
          {
            uri: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
          },
        ],
        resume: false,
      })
      expect(admitted.payload.files?.[0]?.mime).toBe("image/png")
      expect(llm.requests).toHaveLength(0)
      expect(
        yield* session
          .prompt({ text: "Use a missing skill.", skills: [{ id: Skill.ID.make("missing") }], resume: false })
          .pipe(Effect.flip),
      ).toBeInstanceOf(Session.SkillNotFoundError)
      yield* llm.push(TestLLM.text("image received", "image_reply"))
      yield* session.resume()
      expect(llm.requests).toHaveLength(1)
    }),
  )

  it.live("an unavailable initial Source leaves admitted input pending without a model call", () =>
    Effect.gen(function* () {
      const llm = yield* TestLLM.Service
      const sessions = yield* Session.Service
      const instructions = Source.mutable<ReadonlyArray<string> | Instructions.Unavailable>(Instructions.unavailable)
      const session = yield* sessions.open({ model, instructions })
      expect(yield* session.prompt({ text: "Wait for policy." }).pipe(Effect.flip)).toBeInstanceOf(
        Instructions.InitializationBlocked,
      )
      expect(llm.requests).toHaveLength(0)
      expect(yield* sessions.inbox(session.id)).toHaveLength(1)
      yield* instructions.set(["Policy is ready."])
      yield* llm.push(TestLLM.text("ready", "ready_reply"))
      yield* session.resume()
      expect(llm.requests[0].system.map((part) => part.text).join("\n")).toContain("Policy is ready.")
    }),
  )

  it.live("host permission declines interrupt while corrections remain model-facing", () =>
    Effect.gen(function* () {
      const llm = yield* TestLLM.Service
      const sessions = yield* Session.Service
      for (const outcome of ["decline", "correction", "foreign"]) {
        const correction = outcome === "correction"
        const declined = outcome === "decline"
        const permissions: Permissions.Interface = {
          visibility: Permissions.allowAll.visibility,
          ask: () =>
            correction
              ? new Permission.CorrectedError({ feedback: "Use a safer value." })
              : new Permission.DeclinedError(),
        }
        const tool: Tool.Info = {
          ...echo(Effect.succeed),
          options: { codemode: false },
          execute: (input, invocation) =>
            Effect.gen(function* () {
              if (outcome === "foreign") return yield* Effect.fail(new Error("ordinary failure"))
              const session = yield* sessions.get(Session.ID.make(invocation.sessionID))
              yield* permissions
                .ask(session, { action: "echo", resources: [input.text] })
                .pipe(
                  Effect.catchTag("Permission.CorrectedError", (error) => new Tool.Error({ message: error.feedback })),
                )
              return { output: input.text }
            }),
        }
        const session = yield* sessions.open({ model, tools: [tool], permissions })
        const before = llm.requests.length
        yield* llm.push(TestLLM.tool(`permission_${outcome}`, "echo", { text: "requested" }))
        if (!declined) yield* llm.push(TestLLM.text("continued", `continued_${outcome}`))
        const exit = yield* session.prompt({ text: "Request echo." }).pipe(Effect.exit)
        expect(exit._tag).toBe(declined ? "Failure" : "Success")
        expect(llm.requests.length - before).toBe(declined ? 1 : 2)
        const calls = (yield* sessions.messages({ sessionID: session.id })).flatMap((message) =>
          message.type === "assistant" ? message.content.filter((part) => part.type === "tool") : [],
        )
        expect(calls[0].state.status).toBe("error")
        if (calls[0].state.status !== "error") return yield* Effect.die("Expected durable tool failure")
        expect(calls[0].state.error.message).toBe(
          declined ? "The user declined this tool call" : correction ? "Use a safer value." : "ordinary failure",
        )
        if (!declined)
          expect(JSON.stringify(llm.requests[before + 1].messages)).toContain(
            correction ? "Use a safer value." : "ordinary failure",
          )
        if (!declined) {
          const db = (yield* Database.Service).db
          expect(
            (yield* db.select().from(SessionTable).where(eq(SessionTable.id, session.id)).get().pipe(Effect.orDie))
              ?.time_suspended,
          ).toBeNull()
        }
      }
    }),
  )

  it.live("fresh open and reopen share effective capabilities and identical request assembly", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const resolve = yield* SessionResolve.Service
      const db = (yield* Database.Service).db
      const bus = yield* Bus.Service
      const llm = yield* TestLLM.Service
      const input = { model, tools: [echo(Effect.succeed)], instructions: ["Stable policy."], system: "Stable system." }
      const session = yield* sessions.open(input)
      yield* llm.push(TestLLM.text("done", "parity_reply"))
      yield* session.prompt({ text: "hello" })
      const before = yield* sessions.get(session.id)
      const first = yield* resolve.resolve(before)
      if (first.status !== "attached") return yield* Effect.die("Expected supplied capabilities")
      const selected = yield* first.capabilities.select(session.id)
      yield* InstructionState.prepare(db, bus, selected.instructions, session.id)
      const loaded = yield* first.capabilities.load(selected)
      const prepare = (capabilities: typeof first.capabilities, value: typeof loaded) =>
        capabilities.prepare({
          scope: { session: value.session, agentID: value.agent.id, model: value.model, tools: value.tools },
          transcript: { system: [...llm.requests[0].system], messages: [...llm.requests[0].messages] },
        })
      const initial = yield* prepare(first.capabilities, loaded)
      const sequence = yield* Bus.latestSequence(db, session.id)
      const reopened = yield* sessions.open({ ...input, id: session.id, title: "ignored on adopt" })
      expect(yield* sessions.get(reopened.id)).toEqual(before)
      const second = yield* resolve.resolve(before)
      if (second.status !== "attached") return yield* Effect.die("Expected reopened capabilities")
      const reselected = yield* second.capabilities.select(reopened.id)
      yield* InstructionState.prepare(db, bus, reselected.instructions, reopened.id)
      const reloaded = yield* second.capabilities.load(reselected)
      expect(reloaded.initial).toBe(loaded.initial)
      expect(reloaded.agent).toEqual(loaded.agent)
      expect(reloaded.model).toEqual(loaded.model)
      expect(reloaded.tools.definitions).toEqual(loaded.tools.definitions)
      expect((yield* prepare(second.capabilities, reloaded)).request).toEqual(initial.request)
      const call = {
        sessionID: session.id,
        agent: loaded.agent.id,
        messageID: SessionMessage.ID.create(),
        call: {
          type: "tool-call" as const,
          id: "parity_echo",
          name: "execute",
          input: { code: 'return await tools.echo({ text: "same" })' },
        },
      }
      expect(yield* reloaded.tools.execute(call)).toEqual(yield* loaded.tools.execute(call))
      expect(yield* Bus.latestSequence(db, session.id)).toBe(sequence)

      const prior = yield* sessions.create({
        location: Location.Ref.make({ directory: AbsolutePath.make("/prior-host") }),
      })
      const adopted = yield* sessions.open({ ...input, id: prior.id })
      expect(yield* sessions.get(adopted.id)).toEqual(prior)
      yield* llm.push(TestLLM.text("reconnected", "adopt_reply"))
      yield* adopted.prompt({ text: "Reconnect from a different cwd." })
      expect((yield* sessions.get(prior.id)).location).toEqual(prior.location)
    }),
  )

  it.live("hot Sources produce chronological diffs alongside durable entries between busy periods", () =>
    Effect.gen(function* () {
      const llm = yield* TestLLM.Service
      const sessions = yield* Session.Service
      const entries = yield* InstructionEntry.Service
      const db = (yield* Database.Service).db
      const instructions = Source.mutable<ReadonlyArray<string> | Instructions.Unavailable>(["First policy."])
      const tools = Source.mutable([echo(Effect.succeed)])
      const session = yield* sessions.open({ model, tools, instructions })
      yield* entries.put({
        sessionID: session.id,
        key: InstructionEntry.Key.make("thread-policy"),
        value: "Durable policy.",
      })
      yield* llm.push(TestLLM.text("first", "first_reply"))
      yield* session.prompt({ text: "first" })
      const initial = llm.requests[0].system
      yield* instructions.update(() => ["Second policy."])
      yield* tools.update(() => [echo(Effect.succeed, "second_echo")])
      yield* llm.push(TestLLM.text("second", "second_reply"))
      yield* session.prompt({ text: "second" })
      expect(llm.requests[1].system).toEqual(initial)
      const updates = (yield* sessions.messages({ sessionID: session.id })).filter(
        (message) => message.type === "system",
      )
      expect(updates).toHaveLength(1)
      expect(updates[0].text).toContain("Second policy.")
      expect(updates[0].text).toContain("second_echo")
      expect(
        llm.requests[1].messages.some(
          (message) =>
            message.role === "system" &&
            message.content.some((part) => part.type === "text" && part.text.includes("Second policy.")),
        ),
      ).toBe(true)
      const state = yield* db
        .select()
        .from(InstructionStateTable)
        .where(eq(InstructionStateTable.session_id, session.id))
        .get()
        .pipe(Effect.orDie)
      expect(state?.initial_values["session/instructions"]).toBe(Instructions.hash(["First policy."]))
      expect(state?.current_values["session/instructions"]).toBe(Instructions.hash(["Second policy."]))
      expect(state?.current_values["api/thread-policy"]).toBe(Instructions.hash("Durable policy."))

      yield* instructions.set(Instructions.unavailable)
      yield* llm.push(TestLLM.text("retained", "retained_reply"))
      yield* session.prompt({ text: "temporarily unavailable" })
      expect(
        (yield* sessions.messages({ sessionID: session.id })).filter((message) => message.type === "system"),
      ).toHaveLength(1)
      yield* instructions.set([])
      yield* llm.push(TestLLM.text("removed", "removed_reply"))
      yield* session.prompt({ text: "removed" })
      expect(
        (yield* sessions.messages({ sessionID: session.id, order: "asc" }))
          .filter((message) => message.type === "system")
          .at(-1)?.text,
      ).toContain("no longer apply")
    }),
  )

  it.live("pins capabilities across coalesced drains but rereads their Sources at safe boundaries", () =>
    Effect.gen(function* () {
      const llm = yield* TestLLM.Service
      const sessions = yield* Session.Service
      const began = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const settled: string[] = []
      const executed: string[] = []
      const tools = Source.mutable([
        echo((text) =>
          Deferred.succeed(began, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.andThen(
              Effect.sync(() => {
                executed.push("old")
                return text
              }),
            ),
            Effect.ensuring(
              Effect.sync(() => {
                settled.push("tool")
              }),
            ),
          ),
        ),
      ])
      const instructions = Source.mutable(["Old policy."])
      const session = yield* sessions.open({
        model,
        tools,
        instructions,
        retire: () =>
          Effect.sync(() => {
            settled.push("retired")
          }),
      })
      yield* llm.push(
        TestLLM.tool("blocked_echo", "execute", { code: 'return await tools.echo({ text: "blocked" })' }),
        TestLLM.tool("updated_echo", "execute", { code: 'return await tools.updated_echo({ text: "updated" })' }),
        TestLLM.text("finished", "busy_reply"),
      )
      const prompting = yield* session.prompt({ text: "Start work." }).pipe(Effect.forkScoped)
      yield* Deferred.await(began)
      yield* sessions.open({
        model,
        id: session.id,
        tools: [
          echo(
            (text) =>
              Effect.sync(() => {
                executed.push("replacement")
                return text
              }),
            "replacement_echo",
          ),
        ],
        instructions: ["Replacement policy."],
      })
      expect(settled).toEqual([])
      yield* tools.set([
        echo(
          (text) =>
            Effect.sync(() => {
              executed.push("updated source")
              return text
            }),
          "updated_echo",
        ),
      ])
      yield* instructions.set(["Updated old policy."])
      yield* sessions.prompt({ sessionID: session.id, text: "Steer during work." })
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(prompting)
      yield* sessions.wait(session.id)
      expect(executed).toEqual(["old", "updated source"])
      expect(settled).toEqual(["tool", "retired"])
      expect(
        llm.requests[1].messages.some(
          (message) =>
            message.role === "system" &&
            message.content.some((part) => part.type === "text" && part.text.includes("Updated old policy.")),
        ),
      ).toBe(true)
      expect(JSON.stringify(llm.requests.slice(0, 3))).not.toContain("Replacement policy.")
      yield* llm.push(
        TestLLM.tool("replacement_call", "execute", {
          code: 'return await tools.replacement_echo({ text: "replacement" })',
        }),
        TestLLM.text("replacement finished", "replacement_reply"),
      )
      yield* session.prompt({ text: "Next busy period." })
      expect(executed).toEqual(["old", "updated source", "replacement"])
      expect(
        llm.requests[3].messages.some(
          (message) =>
            message.role === "system" &&
            message.content.some((part) => part.type === "text" && part.text.includes("Replacement policy.")),
        ),
      ).toBe(true)
    }),
  )

  it.live("concurrent opens isolate their tools, instructions, and executable snapshots", () =>
    Effect.gen(function* () {
      const llm = yield* TestLLM.Service
      const resolve = yield* SessionResolve.Service
      const sessions = yield* Session.Service
      const gate = yield* llm.gate
      const executed: string[] = []
      const first = yield* sessions.open({
        model,
        tools: [
          echo(
            (text) =>
              Effect.sync(() => {
                executed.push("first")
                return text
              }),
            "first_echo",
          ),
        ],
        instructions: ["First private policy."],
      })
      const second = yield* sessions.open({
        model,
        tools: [
          echo(
            (text) =>
              Effect.sync(() => {
                executed.push("second")
                return text
              }),
            "second_echo",
          ),
        ],
        instructions: ["Second private policy."],
      })
      yield* llm.push(
        TestLLM.tool("first_call", "execute", { code: 'return await tools.first_echo({ text: "first" })' }),
        TestLLM.tool("second_call", "execute", { code: 'return await tools.second_echo({ text: "second" })' }),
        TestLLM.text("first done", "first_isolation_reply"),
        TestLLM.text("second done", "second_isolation_reply"),
      )
      const firstPrompt = yield* first.prompt({ text: "first" }).pipe(Effect.forkScoped)
      yield* llm.wait(1)
      const secondPrompt = yield* second.prompt({ text: "second" }).pipe(Effect.forkScoped)
      yield* llm.wait(2)
      expect(llm.requests).toHaveLength(2)
      const firstRequest = llm.requests.find((request) => request.http?.headers?.["X-Session-Id"] === first.id)
      const secondRequest = llm.requests.find((request) => request.http?.headers?.["X-Session-Id"] === second.id)
      expect(JSON.stringify(firstRequest)).toContain("First private policy.")
      expect(JSON.stringify(firstRequest)).toContain("first_echo")
      expect(JSON.stringify(firstRequest)).not.toContain("Second private policy.")
      expect(JSON.stringify(firstRequest)).not.toContain("second_echo")
      expect(JSON.stringify(secondRequest)).toContain("Second private policy.")
      expect(JSON.stringify(secondRequest)).toContain("second_echo")
      expect(JSON.stringify(secondRequest)).not.toContain("First private policy.")
      yield* gate.release
      yield* Fiber.join(firstPrompt)
      yield* Fiber.join(secondPrompt)
      expect(executed.toSorted()).toEqual(["first", "second"])
      for (const session of [first, second]) {
        const capabilities = yield* resolve.resolve(yield* sessions.get(session.id))
        if (capabilities.status !== "attached") return yield* Effect.die("Expected isolated capabilities")
        const selected = yield* capabilities.capabilities.select(session.id)
        expect(selected.tools.codeModeCatalog?.map((tool) => tool.path)).toEqual([
          session === first ? "first_echo" : "second_echo",
        ])
      }
    }),
  )

  it.live("retires deleted capabilities and removes their durable ownership marker", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const resolve = yield* SessionResolve.Service
      const retired: string[] = []
      const session = yield* sessions.open({
        model,
        retire: () =>
          Effect.sync(() => {
            retired.push("retired")
          }),
      })
      yield* sessions.remove(session.id)
      expect(retired).toEqual(["retired"])
      expect(resolve.status(session.id)).toBe("unowned")
      expect(yield* sessions.get(session.id).pipe(Effect.flip)).toBeInstanceOf(Session.NotFoundError)
    }),
  )
})
