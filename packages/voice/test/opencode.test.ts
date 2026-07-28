import { expect, test } from "bun:test"
import { OpenCode } from "@opencode-ai/client/promise"
import { createOpenCodeBridge } from "../src/opencode"
import type { CompletionStore } from "../src/completion-store"

test("renames and archives only sessions discovered by the voice controller", async () => {
  const requests: Request[] = []
  const server: { archived?: number } = {}
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
      if (url.pathname === "/api/event")
        return new Response("", { headers: { "content-type": "text/event-stream" } })
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
      if (url.pathname === "/api/session/ses_known" && request.method === "GET")
        return Response.json({ data: { ...session, time: { ...session.time, archived: server.archived } } })
      if (url.pathname === "/api/session/ses_known/rename" && request.method === "POST")
        return new Response(null, { status: 204 })
      if (url.pathname === "/api/session/ses_known/archive" && request.method === "POST") {
        server.archived = Date.now()
        return new Response(null, { status: 204 })
      }
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
    onSession: () => {},
    completionStore: memoryCompletionStore(),
  })

  try {
    expect(bridge.definitions.find((tool) => tool.name === "rename_session")).toMatchObject({
      description: expect.stringContaining("does not prompt, wake, or interrupt"),
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["session_id", "title"],
      },
    })
    expect(bridge.definitions.find((tool) => tool.name === "archive_session")).toMatchObject({
      description: expect.stringContaining("explicitly confirms"),
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["session_id"],
      },
    })

    expect(await bridge.execute("rename_session", { session_id: "ses_unknown", title: "Nope" })).toEqual({
      status: "error",
      message: "Use a session ID returned by find_sessions or start_session.",
      retryable: false,
    })
    expect(await bridge.execute("archive_session", {})).toEqual({
      status: "error",
      message: "Use a session ID returned by find_sessions or start_session.",
      retryable: false,
    })
    expect(await bridge.execute("archive_session", { session_id: "ses_unknown" })).toEqual({
      status: "error",
      message: "Use a session ID returned by find_sessions or start_session.",
      retryable: false,
    })
    expect(requests.some((request) => new URL(request.url).pathname.includes("ses_unknown"))).toBe(false)

    await bridge.execute("find_sessions", {
      query: null,
      scope: "current_project",
      recency: "any",
      limit: 10,
    })
    expect(await bridge.execute("rename_session", { session_id: "ses_known", title: "   " })).toEqual({
      status: "error",
      message: "A non-empty session title is required.",
      retryable: false,
    })
    expect(await bridge.execute("rename_session", { session_id: "ses_known", title: "Old title" })).toEqual({
      status: "unchanged",
      session_id: "ses_known",
      previous_title: "Old title",
      title: "Old title",
    })
    expect(requests.some((request) => new URL(request.url).pathname.endsWith("/rename"))).toBe(false)

    expect(await bridge.execute("rename_session", { session_id: "ses_known", title: "  New title  " })).toEqual({
      status: "renamed",
      session_id: "ses_known",
      previous_title: "Old title",
      title: "New title",
    })
    const rename = requests.find((request) => new URL(request.url).pathname.endsWith("/rename"))
    expect(rename?.method).toBe("POST")
    expect(await rename?.json()).toEqual({ title: "New title" })

    expect(await bridge.execute("archive_session", { session_id: "ses_known" })).toEqual({
      status: "archived",
      title: "Old title",
    })
    const archive = requests.find((request) => new URL(request.url).pathname.endsWith("/archive"))
    expect(archive?.method).toBe("POST")
    expect(await archive?.text()).toBe("")
    expect(await bridge.execute("archive_session", { session_id: "ses_known" })).toEqual({
      status: "already_archived",
      title: "Old title",
    })
    expect(requests.filter((request) => new URL(request.url).pathname.endsWith("/archive"))).toHaveLength(1)
    expect(requests.some((request) => /\/(prompt|interrupt)$/.test(new URL(request.url).pathname))).toBe(false)
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
    delivered: async () => {},
    close: async () => {},
  }
}
