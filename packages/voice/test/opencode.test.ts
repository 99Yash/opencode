import { expect, test } from "bun:test"
import { OpenCode } from "@opencode-ai/client/promise"
import { createOpenCodeBridge } from "../src/opencode"
import type { CompletionStore } from "../src/completion-store"

test("renames only a session discovered by the voice controller", async () => {
  const requests: Request[] = []
  const session = {
    id: "ses_known",
    projectID: "project-1",
    cost: "0",
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 2 },
    title: "Old title",
    location: { directory: "/workspace" },
  }
  const fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input.toString(), init)
      requests.push(request)
      const url = new URL(request.url)
      if (url.pathname === "/api/event") return new Response("", { headers: { "content-type": "text/event-stream" } })
      if (url.pathname === "/api/project")
        return Response.json([
          {
            id: "project-1",
            worktree: "/workspace",
            time: { created: 1, updated: 2 },
            sandboxes: [],
          },
        ])
      if (url.pathname === "/api/session" && request.method === "GET")
        return Response.json({ data: [session], cursor: {} })
      if (url.pathname === "/api/session/ses_known" && request.method === "GET") return Response.json({ data: session })
      if (url.pathname === "/api/session/ses_known/rename" && request.method === "POST")
        return new Response(null, { status: 204 })
      return new Response("Not found", { status: 404 })
    },
    { preconnect: () => {} },
  )
  const client = OpenCode.make({
    baseUrl: "https://opencode.test",
    fetch,
  })
  const bridge = await createOpenCodeBridge({
    client,
    directory: "/workspace",
    model: { providerID: "openai", id: "gpt-test" },
    notify: () => {},
    completionStore: memoryCompletionStore(),
  })
  const execute = async (name: string, input: Record<string, unknown>) => (await bridge.execute(name, input)).output

  try {
    expect(new Set(bridge.definitions.map((tool) => tool.name)).size).toBe(bridge.definitions.length)
    expect(bridge.definitions.every((tool) => tool.name.length > 0 && tool.description.length > 0)).toBe(true)
    expect(bridge.definitions.find((tool) => tool.name === "reply_form")).toMatchObject({
      parameters: {
        properties: { answer: { type: "object", additionalProperties: true } },
      },
    })
    expect(bridge.definitions.find((tool) => tool.name === "rename_session")).toMatchObject({
      description: expect.stringContaining("does not prompt, wake, or interrupt"),
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["session_id", "title"],
      },
    })

    expect(await execute("rename_session", { session_id: "ses_unknown", title: "Nope" })).toEqual({
      status: "error",
      message: "Use a session ID returned by find_sessions or start_session.",
      retryable: false,
    })
    expect(requests.some((request) => new URL(request.url).pathname.includes("ses_unknown"))).toBe(false)

    await execute("find_sessions", {
      query: null,
      scope: "current_project",
      recency: "any",
      limit: 10,
    })
    expect(await execute("rename_session", { session_id: "ses_known", title: "   " })).toEqual({
      status: "error",
      message: "A non-empty session title is required.",
      retryable: false,
    })
    expect(await execute("rename_session", { session_id: "ses_known", title: "Old title" })).toEqual({
      status: "unchanged",
      session_id: "ses_known",
      previous_title: "Old title",
      title: "Old title",
    })
    expect(requests.some((request) => new URL(request.url).pathname.endsWith("/rename"))).toBe(false)

    expect(await execute("rename_session", { session_id: "ses_known", title: "  New title  " })).toEqual({
      status: "renamed",
      session_id: "ses_known",
      previous_title: "Old title",
      title: "New title",
    })
    const rename = requests.find((request) => new URL(request.url).pathname.endsWith("/rename"))
    expect(rename?.method).toBe("POST")
    expect(await rename?.json()).toEqual({ title: "New title" })
  } finally {
    await bridge.close()
  }
})

test("retries a lost completion wait and prompts a started session by ID", async () => {
  const requests: Request[] = []
  const prompts: Array<{ readonly id: string; readonly text: string }> = []
  const notifications: Array<unknown> = []
  const traces: Array<{ readonly event: string; readonly data?: Record<string, unknown> }> = []
  let waits = 0
  const fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input.toString(), init)
      requests.push(request)
      const url = new URL(request.url)
      if (url.pathname === "/api/event") return new Response("", { headers: { "content-type": "text/event-stream" } })
      if (url.pathname === "/api/session" && request.method === "POST")
        return Response.json({
          data: {
            id: "ses_focused",
            projectID: "project-1",
            cost: "0",
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: 1, updated: 1 },
            title: "Focused session",
            location: { directory: "/workspace" },
          },
        })
      if (url.pathname === "/api/session/ses_focused/prompt" && request.method === "POST") {
        const body = await request.json()
        if (
          typeof body !== "object" ||
          body === null ||
          !("id" in body) ||
          typeof body.id !== "string" ||
          !("text" in body) ||
          typeof body.text !== "string"
        )
          return new Response("Invalid prompt", { status: 400 })
        prompts.push({ id: body.id, text: body.text })
        return Response.json({ data: { id: body.id, admittedSeq: prompts.length } })
      }
      if (url.pathname === "/api/session/ses_focused/wait" && request.method === "POST") {
        waits += 1
        if (waits === 1) throw new Error("connection closed")
        return new Response(null, { status: 204 })
      }
      if (url.pathname === "/api/session/ses_focused/message" && request.method === "GET")
        return Response.json({
          data: prompts.toReversed().map((prompt) => ({ id: prompt.id, type: "user", text: prompt.text })),
          cursor: {},
        })
      return new Response("Not found", { status: 404 })
    },
    { preconnect: () => {} },
  )
  const bridge = await createOpenCodeBridge({
    client: OpenCode.make({ baseUrl: "https://opencode.test", fetch }),
    directory: "/workspace",
    model: { providerID: "openai", id: "gpt-test" },
    notify: (notification) => notifications.push(notification),
    trace: (event, data) => traces.push({ event, data }),
    completionStore: memoryCompletionStore(),
  })
  const execute = async (name: string, input: Record<string, unknown>) => (await bridge.execute(name, input)).output

  try {
    expect(bridge.definitions.some((tool) => tool.name === "continue_session")).toBe(false)
    const started = await bridge.execute("start_session", { text: "First task", project_id: null })
    expect(started.output).toMatchObject({
      status: "started",
      session_id: "ses_focused",
    })
    expect(started.admittedPrompt).toEqual({ sessionID: "ses_focused", promptID: prompts[0].id })
    expect(
      await execute("prompt_session", { session_id: "ses_focused", text: "Follow-up task" }),
    ).toMatchObject({
      status: "started",
      session_id: "ses_focused",
    })

    await Bun.sleep(1_100)
    expect(prompts.map((prompt) => prompt.text)).toEqual(["First task", "Follow-up task"])
    expect(requests.filter((request) => new URL(request.url).pathname.endsWith("/wait")).length).toBeGreaterThanOrEqual(
      3,
    )
    expect(traces.some((entry) => entry.event === "opencode.wait.retrying")).toBe(true)
    expect(notifications.some((value) => JSON.stringify(value).includes("opencode.prompt.failed"))).toBe(false)
  } finally {
    await bridge.close()
  }
})

test("discards a restored prompt whose session no longer exists", async () => {
  const removed: Array<{ readonly sessionID: string; readonly promptID: string }> = []
  const handle = { sessionID: "ses_missing", promptID: "msg_orphaned" }
  const fetch = Object.assign(
    async (input: string | URL | Request) => {
      const request = input instanceof Request ? input : new Request(input.toString())
      const url = new URL(request.url)
      if (url.pathname === "/api/event") return new Response("", { headers: { "content-type": "text/event-stream" } })
      if (url.pathname === "/api/session/ses_missing")
        return Response.json(
          { _tag: "SessionNotFoundError", sessionID: handle.sessionID, message: `Session not found: ${handle.sessionID}` },
          { status: 404 },
        )
      return new Response("Not found", { status: 404 })
    },
    { preconnect: () => {} },
  )
  const store = {
    ...memoryCompletionStore(),
    entries: () => [{ status: "pending" as const, handle }],
    remove: async (entry) => {
      removed.push(entry)
    },
  } satisfies CompletionStore

  const bridge = await createOpenCodeBridge({
    client: OpenCode.make({ baseUrl: "https://opencode.test", fetch }),
    directory: "/workspace",
    model: { providerID: "openai", id: "gpt-test" },
    notify: () => {},
    completionStore: store,
  })
  try {
    expect(removed).toEqual([handle])
  } finally {
    await bridge.close()
  }
})

function memoryCompletionStore(): CompletionStore {
  return {
    entries: () => [],
    admitting: async () => {},
    pending: async () => {},
    completed: async () => {},
    remove: async () => {},
    close: async () => {},
  }
}
