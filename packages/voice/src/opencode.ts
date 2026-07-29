import { realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, isAbsolute, relative } from "node:path"
import { ClientError, isSessionNotFoundError, OpenCode } from "@opencode-ai/client/promise"
import type { SessionMessageAssistant, SessionMessageUser, V2Event } from "@opencode-ai/client/promise"
import { Form, Question, SessionMessage } from "@opencode-ai/client/effect"
import { Context, Effect, FiberMap, Layer, ManagedRuntime, Option, Schema, Stream } from "effect"
import { createCompletionStore, type CompletionStore } from "./completion-store"
import type {
  CompletionReceipt,
  OpenCodeAnnouncement,
  OpenCodeNotification,
  OpenCodePromptBlocked,
} from "./opencode-notification"
import type { VoiceTool, VoiceToolExecution } from "./protocol"
import type { PromptHandle } from "./prompt-handle"

type Client = ReturnType<typeof OpenCode.make>
const AdmittedPrompt = Symbol("AdmittedPrompt")
type Tool = {
  readonly description: string
  readonly parameters: unknown
  readonly execute: (input: Record<string, unknown>) => Effect.Effect<unknown, unknown>
}
type BridgeApi = {
  readonly definitions: ReadonlyArray<VoiceTool>
  readonly execute: (name: string, input: Record<string, unknown>) => Effect.Effect<VoiceToolExecution, unknown>
  readonly acknowledge: (receipt: CompletionReceipt) => Effect.Effect<void, unknown>
  readonly close: Effect.Effect<void>
}

class Bridge extends Context.Service<Bridge, BridgeApi>()("@opencode-ai/voice/OpenCodeBridge") {}

export async function createOpenCodeBridge(options: {
  client: Client
  directory: string
  model: { readonly providerID: string; readonly id: string; readonly variant?: string }
  notify: (announcement: OpenCodeAnnouncement) => void
  trace?: (event: string, data?: Record<string, unknown>) => void
  completionStore?: CompletionStore
}) {
  const completionStore = options.completionStore ?? (await createCompletionStore())
  const runtime = ManagedRuntime.make(Layer.effect(Bridge, makeBridge({ ...options, completionStore })))
  const bridge = await runtime.runPromise(Bridge)
  return {
    definitions: bridge.definitions,
    execute: (name: string, input: Record<string, unknown>) => runtime.runPromise(bridge.execute(name, input)),
    acknowledge: (receipt: CompletionReceipt) => runtime.runPromise(bridge.acknowledge(receipt)),
    close: async () => {
      await runtime.runPromise(bridge.close)
      await Promise.race([runtime.dispose(), Bun.sleep(1_000)])
      await completionStore.close()
    },
  }
}

const makeBridge = Effect.fnUntraced(function* (options: {
  client: Client
  directory: string
  model: { readonly providerID: string; readonly id: string; readonly variant?: string }
  notify: (announcement: OpenCodeAnnouncement) => void
  trace?: (event: string, data?: Record<string, unknown>) => void
  completionStore: CompletionStore
}) {
  const knownProjects = new Set<string>()
  const knownSessions = new Set<string>()
  const registrations = new Map<string, PromptHandle>()
  const promoted = new Map<string, string>()
  const latest = new Map<string, string>()
  const announcedBlockers = new Set<string>()
  const completions = yield* FiberMap.make<string>()
  const eventAbort = yield* Effect.acquireRelease(
    Effect.sync(() => new AbortController()),
    (controller) => Effect.sync(() => controller.abort()),
  )

  const notify = (notification: OpenCodeNotification, receipt?: CompletionReceipt) =>
    Effect.sync(() => options.notify({ notification, receipt }))
  const trace = (event: string, data: Record<string, unknown>) => Effect.sync(() => options.trace?.(event, data))
  const request = <A>(run: (signal: AbortSignal) => PromiseLike<A>) =>
    Effect.tryPromise({ try: run, catch: (cause) => cause })
  const announceBlocker = (key: string, notification: OpenCodeNotification) => {
    if (announcedBlockers.has(key)) return Effect.void
    announcedBlockers.add(key)
    return notify(notification)
  }
  const clearRegistration = (handle: PromptHandle) =>
    Effect.sync(() => {
      registrations.delete(handle.promptID)
      if (promoted.get(handle.sessionID) === handle.promptID) promoted.delete(handle.sessionID)
      if (latest.get(handle.sessionID) === handle.promptID) latest.delete(handle.sessionID)
    })

  const listProjects = Effect.fnUntraced(function* () {
    const seen = new Set<string>()
    const temporary = realpathSync(tmpdir())
    return (yield* request((signal) => options.client.project.list({ signal })))
      .sort((a, b) => b.time.updated - a.time.updated)
      .filter((project) => {
        const fromTemporary = relative(temporary, project.worktree)
        if (
          project.id === "global" ||
          fromTemporary === "" ||
          (!fromTemporary.startsWith("..") && !isAbsolute(fromTemporary)) ||
          seen.has(project.worktree)
        )
          return false
        seen.add(project.worktree)
        return true
      })
  })

  const projectDirectory = Effect.fnUntraced(function* (projectID: string) {
    if (!knownProjects.has(projectID)) return undefined
    return (yield* listProjects()).find((project) => project.id === projectID)?.worktree
  })

  const complete = Effect.fnUntraced(function* (handle: PromptHandle) {
    yield* trace("opencode.wait.started", handle)
    yield* waitForIdle(handle)
    const reply = yield* request((signal) => finalReply(options.client, handle, signal))
    yield* trace("opencode.wait.completed", { ...handle, replyID: reply?.id, error: reply?.error?.message })
    const notification: OpenCodeNotification = {
      type: "opencode.prompt.completed",
      session_id: handle.sessionID,
      prompt_id: handle.promptID,
      status: reply?.error ? "failed" : "completed",
      text: reply
        ? assistantText(reply) || "OpenCode finished without a text reply."
        : "OpenCode finished without a reply.",
      error: reply?.error?.message,
    }
    yield* request(() => options.completionStore.completed(handle, notification))
    yield* notify(notification, handle)
  })

  const waitForIdle = Effect.fnUntraced(function* (handle: PromptHandle, attempt = 1): Effect.fn.Return<void, unknown> {
    return yield* request((signal) => options.client.session.wait({ sessionID: handle.sessionID }, { signal })).pipe(
      Effect.catch((error) => {
        if (!(error instanceof ClientError) || error.reason !== "Transport") return Effect.fail(error)
        return trace("opencode.wait.retrying", {
          ...handle,
          attempt,
          reason: error.reason,
          cause: error.cause instanceof Error ? error.cause.name : typeof error.cause,
        }).pipe(Effect.andThen(Effect.sleep("1 second")), Effect.andThen(waitForIdle(handle, attempt + 1)))
      }),
    )
  })

  const register = Effect.fnUntraced(function* (handle: PromptHandle) {
    yield* complete(handle).pipe(
      Effect.catch((error) => {
        const notification: OpenCodeNotification = {
          type: "opencode.prompt.failed",
          session_id: handle.sessionID,
          prompt_id: handle.promptID,
          status: "failed",
          error: String(error),
        }
        return request(() => options.completionStore.completed(handle, notification)).pipe(
          Effect.andThen(notify(notification, handle)),
        )
      }),
      Effect.ensuring(clearRegistration(handle)),
      FiberMap.run(completions, handle.promptID, { onlyIfMissing: true, startImmediately: true }),
    )
  })

  const restoreBlockers = Effect.fnUntraced(function* (handle: PromptHandle) {
    const [permissions, questions, forms] = yield* Effect.all(
      [
        request((signal) => options.client.permission.list({ sessionID: handle.sessionID }, { signal })),
        request((signal) => options.client.question.list({ sessionID: handle.sessionID }, { signal })),
        request((signal) => options.client.form.list({ sessionID: handle.sessionID }, { signal })),
      ],
      { concurrency: "unbounded" },
    )
    yield* Effect.forEach(
      [
        ...permissions.map((item) => ({
          key: `permission:${item.id}`,
          notification: {
            type: "opencode.prompt.blocked",
            prompt_id: handle.promptID,
            blocker: "permission",
            session_id: handle.sessionID,
            request_id: item.id,
            action: item.action,
            resources: item.resources,
          } satisfies OpenCodeNotification,
        })),
        ...questions.map((item) => ({
          key: `question:${item.id}`,
          notification: {
            type: "opencode.prompt.blocked",
            prompt_id: handle.promptID,
            blocker: "question",
            session_id: handle.sessionID,
            request_id: item.id,
            questions: item.questions,
          } satisfies OpenCodeNotification,
        })),
        ...forms.map((item) => ({
          key: `form:${item.id}`,
          notification: {
            type: "opencode.prompt.blocked",
            prompt_id: handle.promptID,
            blocker: "form",
            session_id: handle.sessionID,
            form_id: item.id,
            title: item.title,
            fields: item.fields,
          } satisfies OpenCodeNotification,
        })),
      ],
      (item) => announceBlocker(item.key, item.notification),
      { discard: true },
    )
  })

  const admit = Effect.fnUntraced(function* (sessionID: string, text: string) {
    const handle = { sessionID, promptID: SessionMessage.ID.create() }
    registrations.set(handle.promptID, handle)
    latest.set(sessionID, handle.promptID)
    yield* trace("opencode.prompt.admitting", handle)
    yield* request(() => options.completionStore.admitting(handle, text))
    const admitted = yield* request((signal) =>
      options.client.session.prompt({ sessionID, id: handle.promptID, text }, { signal }),
    ).pipe(
      Effect.tapError(() =>
        request(() => options.completionStore.remove(handle)).pipe(
          Effect.andThen(clearRegistration(handle)),
        ),
      ),
    )
    knownSessions.add(sessionID)
    yield* request(() => options.completionStore.pending(handle))
    yield* trace("opencode.prompt.admitted", { ...handle, admittedSeq: admitted.admittedSeq })
    yield* register(handle)
    return {
      status: "started",
      session_id: sessionID,
      prompt_id: admitted.id,
      notification: "registered",
      message: "OpenCode accepted the prompt and will send a completion notification. Continue the conversation now.",
      [AdmittedPrompt]: handle,
    }
  })

  const start = Effect.fnUntraced(function* (text: string, projectID?: string) {
    const directory = projectID ? yield* projectDirectory(projectID) : options.directory
    if (!directory) return toolError("Use a project ID returned by find_projects.")
    const session = yield* request((signal) =>
      options.client.session.create({ location: { directory }, model: options.model }, { signal }),
    )
    return yield* admit(session.id, text)
  })

  const tools: Record<string, Tool> = {
    find_projects: {
      description: "Find known OpenCode projects by display name. Returns opaque IDs, never filesystem paths.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          query: { type: ["string", "null"], description: "Name fragment, or null for recent projects." },
          limit: { type: "integer", minimum: 1, maximum: 20 },
        },
        required: ["query", "limit"],
      },
      execute: Effect.fnUntraced(function* (input) {
        const query = typeof input["query"] === "string" ? input["query"].toLowerCase() : undefined
        const limit = typeof input["limit"] === "number" ? input["limit"] : 10
        const projects = (yield* listProjects())
          .filter((project) => !query || projectLabel(project).toLowerCase().includes(query))
          .slice(0, limit)
        projects.forEach((project) => knownProjects.add(project.id))
        return {
          status: "ok",
          projects: projects.map((project) => ({
            id: project.id,
            name: projectLabel(project),
            directories: 1 + project.sandboxes.length,
            updated: new Date(project.time.updated).toISOString(),
          })),
        }
      }),
    },
    find_sessions: {
      description:
        "Find root OpenCode sessions by title and recency. Search the launch project by default; use all_projects only when requested or the local search misses.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          query: { type: ["string", "null"], description: "Title words, or null for recent sessions." },
          scope: { type: "string", enum: ["current_project", "all_projects"] },
          recency: { type: "string", enum: ["day", "week", "month", "any"] },
          limit: { type: "integer", minimum: 1, maximum: 20 },
        },
        required: ["query", "scope", "recency", "limit"],
      },
      execute: Effect.fnUntraced(function* (input) {
        const query = typeof input["query"] === "string" ? input["query"] : undefined
        const scope = input["scope"] === "all_projects" ? "all_projects" : "current_project"
        const recency = typeof input["recency"] === "string" ? input["recency"] : "any"
        const limit = typeof input["limit"] === "number" ? input["limit"] : 10
        const durations: Record<string, number> = { day: 86_400_000, week: 604_800_000, month: 2_592_000_000 }
        const threshold = recency === "any" ? 0 : Date.now() - (durations[recency] ?? 0)
        const [result, projectList] = yield* Effect.all(
          [
            request((signal) =>
              options.client.session.list(
                {
                  ...(scope === "current_project" ? { directory: options.directory } : {}),
                  search: query,
                  parentID: null,
                  limit: recency === "any" ? limit : Math.min(limit * 5, 100),
                  order: "desc",
                },
                { signal },
              ),
            ),
            listProjects(),
          ],
          { concurrency: "unbounded" },
        )
        const projects = new Map(projectList.map((project) => [project.id, projectLabel(project)]))
        const sessions = result.data
          .filter((session) => projects.has(session.projectID) && session.time.updated >= threshold)
          .slice(0, limit)
        sessions.forEach((session) => knownSessions.add(session.id))
        return {
          status: "ok",
          scope,
          sessions: sessions.map((session) => ({
            id: session.id,
            title: session.title,
            project: projects.get(session.projectID) ?? "project",
            updated: new Date(session.time.updated).toISOString(),
          })),
        }
      }),
    },
    read_session: {
      description:
        "Read bounded recent user and assistant text from a session returned by find_sessions or start_session. This never prompts or wakes the coding agent.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          session_id: { type: "string", description: "Session ID returned by a previous voice tool." },
          limit: { type: "integer", minimum: 1, maximum: 20 },
        },
        required: ["session_id", "limit"],
      },
      execute: Effect.fnUntraced(function* (input) {
        const sessionID = knownSession(input, knownSessions)
        if (!sessionID) return toolError("Use a session ID returned by find_sessions or start_session.")
        const limit = typeof input["limit"] === "number" ? input["limit"] : 10
        const [session, messages] = yield* Effect.all(
          [
            request((signal) => options.client.session.get({ sessionID }, { signal })),
            request((signal) => options.client.message.list({ sessionID, order: "desc", limit }, { signal })),
          ],
          { concurrency: "unbounded" },
        )
        const latestAssistant = messages.data.find(
          (message): message is SessionMessageAssistant => message.type === "assistant",
        )
        return {
          status: "ok",
          title: session.title,
          running: latestAssistant ? !latestAssistant.time.completed : false,
          messages: messages.data
            .toReversed()
            .flatMap((message) =>
              message.type === "user" || message.type === "assistant" ? [sessionMessage(message)] : [],
            ),
        }
      }),
    },
    rename_session: {
      description:
        "Rename a session returned by find_sessions or start_session after the user requests a new title. This changes only the display title and does not prompt, wake, or interrupt the coding agent.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          session_id: { type: "string", description: "Session ID returned by a previous voice tool." },
          title: { type: "string", description: "The complete new session title." },
        },
        required: ["session_id", "title"],
      },
      execute: Effect.fnUntraced(function* (input) {
        const sessionID = knownSession(input, knownSessions)
        const title = requireString(input, "title")?.trim()
        if (!sessionID) return toolError("Use a session ID returned by find_sessions or start_session.")
        if (!title) return toolError("A non-empty session title is required.")
        const session = yield* request((signal) => options.client.session.get({ sessionID }, { signal }))
        if (session.title === title)
          return { status: "unchanged", session_id: sessionID, previous_title: session.title, title }
        yield* request((signal) => options.client.session.rename({ sessionID, title }, { signal }))
        return { status: "renamed", session_id: sessionID, previous_title: session.title, title }
      }),
    },
    start_session: {
      description:
        "Create an OpenCode session, admit its first prompt, and register a one-shot completion notification. Omit project_id to use the launch project.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          text: { type: "string", description: "Clear instruction for the coding agent." },
          project_id: { type: ["string", "null"], description: "Opaque project ID, or null for the launch project." },
        },
        required: ["text", "project_id"],
      },
      execute: (input) => {
        const text = requireString(input, "text")
        if (!text) return Effect.succeed(toolError("Task text is required."))
        return start(text, typeof input["project_id"] === "string" ? input["project_id"] : undefined)
      },
    },
    prompt_session: {
      description:
        "Admit a prompt into a discovered or previously started OpenCode session and register a one-shot completion notification.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          session_id: { type: "string", description: "Session ID returned by a previous voice tool." },
          text: { type: "string", description: "Clear instruction for the coding agent." },
        },
        required: ["session_id", "text"],
      },
      execute: (input) => {
        const sessionID = knownSession(input, knownSessions)
        const text = requireString(input, "text")
        if (!sessionID) return Effect.succeed(toolError("Use a session ID returned by find_sessions or start_session."))
        if (!text) return Effect.succeed(toolError("Task text is required."))
        return admit(sessionID, text)
      },
    },
    interrupt_session: {
      description: "Interrupt one OpenCode session. Call only after the user explicitly confirms the interruption.",
      parameters: sessionParameters(),
      execute: Effect.fnUntraced(function* (input) {
        const sessionID = knownSession(input, knownSessions)
        if (!sessionID) return toolError("Use a session ID returned by a previous voice tool.")
        yield* request((signal) => options.client.session.interrupt({ sessionID }, { signal }))
        return { status: "interrupted", session_id: sessionID }
      }),
    },
    list_pending_permissions: {
      description: "List permission requests blocking one OpenCode session.",
      parameters: sessionParameters(),
      execute: Effect.fnUntraced(function* (input) {
        const sessionID = knownSession(input, knownSessions)
        if (!sessionID) return toolError("Use a session ID returned by a previous voice tool.")
        const requests = yield* request((signal) => options.client.permission.list({ sessionID }, { signal }))
        return {
          status: "ok",
          requests: requests.map((item) => ({ id: item.id, action: item.action, resources: item.resources })),
        }
      }),
    },
    reply_permission: {
      description:
        "Allow once or reject a pending permission after stating the action and resources and receiving the user's explicit decision.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          session_id: { type: "string" },
          request_id: { type: "string" },
          decision: { type: "string", enum: ["allow_once", "reject"] },
        },
        required: ["session_id", "request_id", "decision"],
      },
      execute: Effect.fnUntraced(function* (input) {
        const sessionID = knownSession(input, knownSessions)
        const requestID = requireString(input, "request_id")
        const decision = input["decision"]
        if (!sessionID || !requestID || (decision !== "allow_once" && decision !== "reject"))
          return toolError("A known session, request ID, and valid decision are required.")
        const requests = yield* request((signal) => options.client.permission.list({ sessionID }, { signal }))
        if (!requests.some((item) => item.id === requestID))
          return toolError("That permission request is not pending.", true)
        yield* request((signal) =>
          options.client.permission.reply(
            { sessionID, requestID, reply: decision === "allow_once" ? "once" : "reject" },
            { signal },
          ),
        )
        return { status: decision === "allow_once" ? "allowed_once" : "rejected", request_id: requestID }
      }),
    },
    reply_question: {
      description: "Reply to questions blocking an OpenCode session after collecting the user's answers.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          session_id: { type: "string" },
          request_id: { type: "string" },
          answers: {
            type: "array",
            description: "One string array per question, preserving question order.",
            items: { type: "array", items: { type: "string" } },
          },
        },
        required: ["session_id", "request_id", "answers"],
      },
      execute: Effect.fnUntraced(function* (input) {
        const sessionID = knownSession(input, knownSessions)
        const requestID = requireString(input, "request_id")
        const answers = Option.getOrUndefined(decodeQuestionAnswers(input["answers"]))
        if (!sessionID || !requestID || !answers)
          return toolError("A known session, request ID, and valid answers are required.")
        yield* request((signal) => options.client.question.reply({ sessionID, requestID, answers }, { signal }))
        return { status: "answered", request_id: requestID }
      }),
    },
    reject_question: {
      description: "Reject a pending OpenCode question after the user explicitly declines to answer.",
      parameters: requestParameters(),
      execute: Effect.fnUntraced(function* (input) {
        const sessionID = knownSession(input, knownSessions)
        const requestID = requireString(input, "request_id")
        if (!sessionID || !requestID) return toolError("A known session and request ID are required.")
        yield* request((signal) => options.client.question.reject({ sessionID, requestID }, { signal }))
        return { status: "rejected", request_id: requestID }
      }),
    },
    reply_form: {
      description: "Submit values for a form blocking an OpenCode session after collecting them from the user.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          session_id: { type: "string" },
          form_id: { type: "string" },
          answer: { type: "object", additionalProperties: true },
        },
        required: ["session_id", "form_id", "answer"],
      },
      execute: Effect.fnUntraced(function* (input) {
        const sessionID = knownSession(input, knownSessions)
        const formID = requireString(input, "form_id")
        const answer = Option.getOrUndefined(decodeFormAnswer(input["answer"]))
        if (!sessionID || !formID || !answer)
          return toolError("A known session, form ID, and valid answer are required.")
        yield* request((signal) => options.client.form.reply({ sessionID, formID, answer }, { signal }))
        return { status: "answered", form_id: formID }
      }),
    },
    cancel_form: {
      description: "Cancel a pending OpenCode form after the user explicitly declines to complete it.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: { session_id: { type: "string" }, form_id: { type: "string" } },
        required: ["session_id", "form_id"],
      },
      execute: Effect.fnUntraced(function* (input) {
        const sessionID = knownSession(input, knownSessions)
        const formID = requireString(input, "form_id")
        if (!sessionID || !formID) return toolError("A known session and form ID are required.")
        yield* request((signal) => options.client.form.cancel({ sessionID, formID }, { signal }))
        return { status: "cancelled", form_id: formID }
      }),
    },
  }

  const definitions = Object.entries(tools).map(
    ([name, tool]) =>
      ({ type: "function", name, description: tool.description, parameters: tool.parameters }) satisfies VoiceTool,
  )

  yield* Effect.suspend(() =>
    Stream.fromAsyncIterable(options.client.event.subscribe({ signal: eventAbort.signal }), (cause) => cause).pipe(
      Stream.runForEach((event) => {
        if (event.type === "session.input.promoted") {
          if (!registrations.has(event.data.inputID)) return Effect.void
          promoted.set(event.data.sessionID, event.data.inputID)
          return trace("opencode.prompt.promoted", {
            sessionID: event.data.sessionID,
            promptID: event.data.inputID,
          })
        }
        const sessionID = blockerSession(event)
        const promptID = sessionID ? (promoted.get(sessionID) ?? latest.get(sessionID)) : undefined
        const blocker = sessionID && promptID ? blockerNotification(event, sessionID, promptID) : undefined
        if (!blocker || !promptID) return Effect.void
        options.trace?.("opencode.prompt.blocked", { sessionID, promptID, blocker: blocker["blocker"] })
        if (registrations.has(promptID)) return announceBlocker(blockerKey(blocker), blocker)
        return Effect.void
      }),
      Effect.catch((error) => notify({ type: "opencode.events.failed", error: String(error) })),
      Effect.andThen(Effect.sleep("1 second")),
    ),
  ).pipe(Effect.forever, Effect.forkScoped({ startImmediately: true }))

  yield* Effect.forEach(
    options.completionStore.entries(),
    Effect.fnUntraced(function* (entry) {
      if (entry.status !== "completed") {
        const exists = yield* request((signal) =>
          options.client.session.get({ sessionID: entry.handle.sessionID }, { signal }),
        ).pipe(
          Effect.as(true),
          Effect.catch((error) => {
            if (!isSessionNotFoundError(error)) return Effect.fail(error)
            return request(() => options.completionStore.remove(entry.handle)).pipe(
              Effect.andThen(trace("opencode.prompt.orphaned", entry.handle)),
              Effect.as(false),
            )
          }),
        )
        if (!exists) return
      }
      knownSessions.add(entry.handle.sessionID)
      if (entry.status === "admitting") {
        registrations.set(entry.handle.promptID, entry.handle)
        latest.set(entry.handle.sessionID, entry.handle.promptID)
        yield* trace("opencode.prompt.reconciling", entry.handle)
        yield* request((signal) =>
          options.client.session.prompt(
            { sessionID: entry.handle.sessionID, id: entry.handle.promptID, text: entry.text },
            { signal },
          ),
        )
        yield* request(() => options.completionStore.pending(entry.handle))
        yield* restoreBlockers(entry.handle)
        yield* register(entry.handle)
        return
      }
      if (entry.status === "pending") {
        registrations.set(entry.handle.promptID, entry.handle)
        latest.set(entry.handle.sessionID, entry.handle.promptID)
        yield* trace("opencode.wait.restored", entry.handle)
        yield* restoreBlockers(entry.handle)
        yield* register(entry.handle)
        return
      }
      yield* trace("opencode.notification.restored", entry.handle)
      yield* notify(entry.notification, entry.handle)
    }),
    { concurrency: 4, discard: true },
  )

  return Bridge.of({
    definitions,
    execute: (name, input) =>
      (tools[name]?.execute(input) ?? Effect.succeed(toolError(`Unknown tool ${name}.`))).pipe(
        Effect.map(toolExecution),
      ),
    acknowledge: (receipt) => request(() => options.completionStore.remove(receipt)),
    close: Effect.all([Effect.sync(() => eventAbort.abort()), FiberMap.clear(completions)], { discard: true }),
  })
})

function toolExecution(output: unknown): VoiceToolExecution {
  if (!isPromptToolOutput(output)) return { output }
  return {
    output: Object.fromEntries(Object.entries(output)),
    admittedPrompt: output[AdmittedPrompt],
  }
}

function isPromptToolOutput(
  output: unknown,
): output is Record<string, unknown> & { readonly [AdmittedPrompt]: PromptHandle } {
  if (!output || typeof output !== "object" || !(AdmittedPrompt in output)) return false
  const handle = output[AdmittedPrompt]
  return (
    !!handle &&
    typeof handle === "object" &&
    "sessionID" in handle &&
    typeof handle.sessionID === "string" &&
    "promptID" in handle &&
    typeof handle.promptID === "string"
  )
}

async function finalReply(client: Client, handle: PromptHandle, signal: AbortSignal) {
  let reply: SessionMessageAssistant | undefined
  let cursor: string | undefined
  while (true) {
    const page = await client.message.list(
      cursor
        ? { sessionID: handle.sessionID, limit: 200, cursor }
        : { sessionID: handle.sessionID, limit: 200, order: "desc" },
      { signal },
    )
    for (const message of page.data) {
      if (message.id === handle.promptID) return reply
      if (message.type === "user") reply = undefined
      if (message.type === "assistant" && !reply) reply = message
    }
    cursor = page.cursor.next ?? undefined
    if (!cursor) return undefined
  }
}

function assistantText(message: SessionMessageAssistant) {
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .slice(0, 4_000)
}

function sessionMessage(message: SessionMessageUser | SessionMessageAssistant) {
  if (message.type === "user") return { role: "user", text: message.text.slice(0, 2_000) }
  return {
    role: "assistant",
    status: message.time.completed ? "completed" : "running",
    text: assistantText(message),
    tools: message.content
      .filter((part) => part.type === "tool")
      .map((part) => ({ name: part.name, status: part.state.status })),
  }
}

function blockerSession(event: V2Event) {
  if (event.type === "permission.v2.asked" || event.type === "question.v2.asked") return event.data.sessionID
  if (event.type === "form.created") return event.data.form.sessionID
  return undefined
}

function blockerNotification(event: V2Event, sessionID: string, promptID: string): OpenCodePromptBlocked | undefined {
  if (event.type === "permission.v2.asked")
    return {
      type: "opencode.prompt.blocked",
      prompt_id: promptID,
      blocker: "permission",
      session_id: sessionID,
      request_id: event.data.id,
      action: event.data.action,
      resources: event.data.resources,
    }
  if (event.type === "question.v2.asked")
    return {
      type: "opencode.prompt.blocked",
      prompt_id: promptID,
      blocker: "question",
      session_id: sessionID,
      request_id: event.data.id,
      questions: event.data.questions,
    }
  if (event.type === "form.created")
    return {
      type: "opencode.prompt.blocked",
      prompt_id: promptID,
      blocker: "form",
      session_id: sessionID,
      form_id: event.data.form.id,
      title: event.data.form.title,
      fields: event.data.form.fields,
    }
  return undefined
}

function blockerKey(notification: OpenCodePromptBlocked) {
  if (notification.blocker === "form") return `form:${notification.form_id}`
  return `${notification.blocker}:${notification.request_id}`
}

function projectLabel(project: { readonly name?: string; readonly worktree: string }) {
  return project.name ?? (basename(project.worktree) || "project")
}

function requireString(input: Record<string, unknown>, key: string) {
  const value = input[key]
  if (typeof value !== "string" || value.trim().length === 0) return undefined
  return value
}

function knownSession(input: Record<string, unknown>, known: ReadonlySet<string>) {
  const sessionID = requireString(input, "session_id")
  if (!sessionID || !known.has(sessionID)) return undefined
  return sessionID
}

const decodeQuestionAnswers = Schema.decodeUnknownOption(Schema.Array(Question.Answer))
const decodeFormAnswer = Schema.decodeUnknownOption(Form.Answer)

function sessionParameters() {
  return {
    type: "object",
    additionalProperties: false,
    properties: { session_id: { type: "string" } },
    required: ["session_id"],
  }
}

function requestParameters() {
  return {
    type: "object",
    additionalProperties: false,
    properties: { session_id: { type: "string" }, request_id: { type: "string" } },
    required: ["session_id", "request_id"],
  }
}

function toolError(message: string, retryable = false) {
  return { status: "error", message, retryable }
}
