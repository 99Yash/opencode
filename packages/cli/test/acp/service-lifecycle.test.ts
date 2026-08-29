import { describe, expect, test } from "bun:test"
import type { SessionConfigOption } from "@agentclientprotocol/sdk"
import { makeACPFixture, makeSession, secondModel } from "./service-fixture"
import { withTimeout } from "./sse-fixture"

describe("acp service lifecycle", () => {
  test("does not persist the first catalog variant when no explicit default exists", async () => {
    const model = { ...secondModel, variants: [{ id: "none" }, { id: "high" }] }
    await using fixture = makeACPFixture({
      models: [model],
      defaultModel: model,
      fetch(request) {
        if (request.method === "POST" && request.path === "/api/session") {
          return Response.json({
            data: makeSession("ses_default_variant", {
              model: { providerID: model.providerID, id: model.id },
            }),
          })
        }
        return undefined
      },
    })

    const created = await fixture.service.newSession({ cwd: "/workspace", mcpServers: [] })

    expect(fixture.requests).toContainEqual({
      method: "POST",
      path: "/api/session",
      query: {},
      body: {
        location: { directory: "/workspace" },
        agent: "build",
        model: { providerID: "test", id: "second-model" },
      },
    })
    expect(currentValue(created, "effort")).toBe("none")
  })

  test("loads and forks with paginated replay while resume does not replay", async () => {
    await using fixture = makeACPFixture({
      fetch(request) {
        if (request.method === "GET" && request.path === "/api/session/ses_loaded") {
          return Response.json({
            data: makeSession("ses_loaded", {
              cwd: "/workspace",
              agent: "plan",
              model: { providerID: "test", id: secondModel.id, variant: "medium" },
            }),
          })
        }
        if (request.method === "GET" && request.path === "/api/session/ses_resume") {
          return Response.json({
            data: makeSession("ses_resume", {
              cwd: "/workspace",
              agent: "plan",
              model: { providerID: "test", id: secondModel.id, variant: "low" },
            }),
          })
        }
        if (request.method === "POST" && request.path === "/api/session/ses_loaded/fork") {
          return Response.json({
            data: makeSession("ses_fork", {
              cwd: "/workspace",
              agent: "plan",
              model: { providerID: "test", id: secondModel.id, variant: "medium" },
            }),
          })
        }
        if (request.method === "GET" && request.path === "/api/session/ses_loaded/message") {
          if (request.query.cursor === "messages-2") {
            return Response.json({
              data: [
                {
                  id: "msg_assistant",
                  type: "assistant",
                  content: [{ type: "text", text: "hi there" }],
                },
              ],
              cursor: {},
            })
          }
          return Response.json({
            data: [{ id: "msg_user", type: "user", text: "hello", time: { created: 1 } }],
            cursor: { next: "messages-2" },
          })
        }
        if (request.method === "GET" && request.path === "/api/session/ses_fork/message") {
          return Response.json({
            data: [{ id: "msg_fork", type: "user", text: "forked", time: { created: 2 } }],
            cursor: {},
          })
        }
        return undefined
      },
    })

    const loaded = await fixture.service.loadSession({
      cwd: "/ignored",
      sessionId: "ses_loaded",
      mcpServers: [],
    })
    const resumed = await fixture.service.resumeSession({
      cwd: "/ignored",
      sessionId: "ses_resume",
      mcpServers: [],
    })
    const forked = await fixture.service.forkSession({
      cwd: "/ignored",
      sessionId: "ses_loaded",
      mcpServers: [],
    })

    expect(currentValue(loaded, "model")).toBe("test/second-model")
    expect(currentValue(loaded, "effort")).toBe("medium")
    expect(currentValue(loaded, "mode")).toBe("plan")
    expect(currentValue(resumed, "effort")).toBe("low")
    expect(forked.sessionId).toBe("ses_fork")
    expect(currentValue(forked, "effort")).toBe("medium")
    expect(
      fixture.updates.filter(
        (item) =>
          item.update.sessionUpdate === "user_message_chunk" || item.update.sessionUpdate === "agent_message_chunk",
      ),
    ).toEqual([
      {
        sessionId: "ses_loaded",
        update: {
          sessionUpdate: "user_message_chunk",
          messageId: "msg_user",
          content: { type: "text", text: "hello" },
        },
      },
      {
        sessionId: "ses_loaded",
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: "msg_assistant",
          content: { type: "text", text: "hi there" },
        },
      },
      {
        sessionId: "ses_fork",
        update: {
          sessionUpdate: "user_message_chunk",
          messageId: "msg_fork",
          content: { type: "text", text: "forked" },
        },
      },
    ])
    expect(
      fixture.requests
        .filter((request) => request.path.endsWith("/message"))
        .map((request) => ({ path: request.path, query: request.query })),
    ).toEqual([
      {
        path: "/api/session/ses_loaded/message",
        query: { limit: "200", order: "asc" },
      },
      {
        path: "/api/session/ses_loaded/message",
        query: { limit: "200", cursor: "messages-2" },
      },
      {
        path: "/api/session/ses_fork/message",
        query: { limit: "200", order: "asc" },
      },
    ])
    expect(fixture.requests).toContainEqual({
      method: "POST",
      path: "/api/session/ses_loaded/fork",
      query: {},
      body: { boundary: { type: "through" } },
    })
  })

  test("loads authoritative config after an overlapping switch completes", async () => {
    const switchStarted = Promise.withResolvers<void>()
    const releaseSwitch = Promise.withResolvers<void>()
    const nativeFetch = fetch
    let switching = true
    let serverModel = makeSession("server").model
    await using fixture = makeACPFixture({
      clientFetch(input, init) {
        const url = new URL(input instanceof Request ? input.url : input.toString())
        if (init?.method !== "GET" || url.pathname !== "/api/session/ses_load_during_switch") {
          return nativeFetch(input, init)
        }
        return Promise.resolve(Response.json({ data: makeSession("ses_load_during_switch", { model: serverModel }) }))
      },
      fetch(request) {
        if (request.method === "POST" && request.path === "/api/session") {
          return Response.json({ data: makeSession("ses_load_during_switch", { model: serverModel }) })
        }
        if (request.method === "POST" && request.path === "/api/session/ses_load_during_switch/model") {
          if (!switching) return new Response(null, { status: 204 })
          switching = false
          switchStarted.resolve()
          return releaseSwitch.promise.then(() => {
            serverModel = { providerID: "test", id: secondModel.id }
            return new Response(null, { status: 204 })
          })
        }
        if (request.method === "GET" && request.path === "/api/session/ses_load_during_switch/message") {
          return Response.json({ data: [], cursor: {} })
        }
        return undefined
      },
    })
    const session = await fixture.service.newSession({ cwd: "/workspace", mcpServers: [] })

    const switched = fixture.service.setSessionConfigOption({
      sessionId: session.sessionId,
      configId: "model",
      value: "test/second-model",
    })
    await switchStarted.promise
    const loaded = fixture.service.loadSession({ cwd: "/workspace", sessionId: session.sessionId, mcpServers: [] })
    releaseSwitch.resolve()
    await switched
    const result = await loaded
    const effort = await fixture.service.setSessionConfigOption({
      sessionId: session.sessionId,
      configId: "effort",
      value: "medium",
    })

    expect(currentValue(result, "model")).toBe("test/second-model")
    expect(currentValue(effort, "effort")).toBe("medium")
  })

  test("detaches and resumes after an overlapping switch completes", async () => {
    const switchStarted = Promise.withResolvers<void>()
    const releaseSwitch = Promise.withResolvers<void>()
    const nativeFetch = fetch
    let switching = true
    let serverModel = makeSession("server").model
    await using fixture = makeACPFixture({
      clientFetch(input, init) {
        const url = new URL(input instanceof Request ? input.url : input.toString())
        if (init?.method !== "GET" || url.pathname !== "/api/session/ses_resume_during_switch") {
          return nativeFetch(input, init)
        }
        return Promise.resolve(Response.json({ data: makeSession("ses_resume_during_switch", { model: serverModel }) }))
      },
      fetch(request) {
        if (request.method === "POST" && request.path === "/api/session") {
          return Response.json({ data: makeSession("ses_resume_during_switch", { model: serverModel }) })
        }
        if (request.method === "POST" && request.path === "/api/session/ses_resume_during_switch/model") {
          if (!switching) return new Response(null, { status: 204 })
          switching = false
          switchStarted.resolve()
          return releaseSwitch.promise.then(() => {
            serverModel = { providerID: "test", id: secondModel.id }
            return new Response(null, { status: 204 })
          })
        }
        if (request.method === "POST" && request.path === "/api/session/ses_resume_during_switch/interrupt") {
          return new Response(null, { status: 204 })
        }
        return undefined
      },
    })
    const session = await fixture.service.newSession({ cwd: "/workspace", mcpServers: [] })

    const switched = fixture.service.setSessionConfigOption({
      sessionId: session.sessionId,
      configId: "model",
      value: "test/second-model",
    })
    await switchStarted.promise
    const closed = fixture.service.closeSession({ sessionId: session.sessionId })
    const resumed = fixture.service.resumeSession({ cwd: "/workspace", sessionId: session.sessionId, mcpServers: [] })
    releaseSwitch.resolve()
    await Promise.all([switched, closed])
    const result = await resumed
    const effort = await fixture.service.setSessionConfigOption({
      sessionId: session.sessionId,
      configId: "effort",
      value: "medium",
    })

    expect(currentValue(result, "model")).toBe("test/second-model")
    expect(currentValue(effort, "effort")).toBe("medium")
  })

  test("forks from authoritative parent config after an overlapping switch completes", async () => {
    const switchStarted = Promise.withResolvers<void>()
    const releaseSwitch = Promise.withResolvers<void>()
    const nativeFetch = fetch
    let serverModel = makeSession("server").model
    await using fixture = makeACPFixture({
      clientFetch(input, init) {
        const url = new URL(input instanceof Request ? input.url : input.toString())
        if (init?.method !== "POST" || url.pathname !== "/api/session/ses_fork_parent/fork") {
          return nativeFetch(input, init)
        }
        return Promise.resolve(
          Response.json({ data: makeSession("ses_fork_child", { model: serverModel, agent: "build" }) }),
        )
      },
      fetch(request) {
        if (request.method === "POST" && request.path === "/api/session") {
          return Response.json({ data: makeSession("ses_fork_parent", { model: serverModel }) })
        }
        if (request.method === "POST" && request.path === "/api/session/ses_fork_parent/model") {
          switchStarted.resolve()
          return releaseSwitch.promise.then(() => {
            serverModel = { providerID: "test", id: secondModel.id }
            return new Response(null, { status: 204 })
          })
        }
        if (request.method === "GET" && request.path === "/api/session/ses_fork_child/message") {
          return Response.json({ data: [], cursor: {} })
        }
        return undefined
      },
    })
    const session = await fixture.service.newSession({ cwd: "/workspace", mcpServers: [] })

    const switched = fixture.service.setSessionConfigOption({
      sessionId: session.sessionId,
      configId: "model",
      value: "test/second-model",
    })
    await switchStarted.promise
    const forked = fixture.service.forkSession({ cwd: "/workspace", sessionId: session.sessionId, mcpServers: [] })
    releaseSwitch.resolve()
    await switched
    const result = await forked

    expect(result.sessionId).toBe("ses_fork_child")
    expect(currentValue(result, "model")).toBe("test/second-model")
  })

  test("keeps the prior attachment when staged MCP, command, or replay setup fails", async () => {
    let phase: "mcp" | "commands" | "replay" | "success" = "mcp"
    await using fixture = makeACPFixture({
      sessionUpdate: async () => {
        if (phase === "commands") throw new Error("command publication failed")
      },
      fetch(request) {
        if (request.method === "POST" && request.path === "/api/session") {
          return Response.json({ data: makeSession("ses_attach_transaction") })
        }
        if (request.method === "GET" && request.path === "/api/session/ses_attach_transaction") {
          return Response.json({
            data: makeSession("ses_attach_transaction", {
              model: { providerID: secondModel.providerID, id: secondModel.id },
            }),
          })
        }
        if (request.method === "POST" && request.path === "/api/session/ses_attach_transaction/model") {
          return new Response(null, { status: 204 })
        }
        if (request.method === "GET" && request.path === "/api/session/ses_attach_transaction/message") {
          if (phase === "replay") return new Response(null, { status: 500 })
          return Response.json({ data: [], cursor: {} })
        }
        if (request.method === "PUT" && request.path === "/api/mcp/docs" && phase === "mcp") {
          return new Response(null, { status: 500 })
        }
        if (request.method === "PUT" && request.path.startsWith("/api/mcp/")) {
          return new Response(null, { status: 204 })
        }
        if (request.method === "DELETE" && request.path.startsWith("/api/mcp/")) {
          return new Response(null, { status: 204 })
        }
        return undefined
      },
    })
    const session = await fixture.service.newSession({ cwd: "/workspace", mcpServers: [] })
    const tools = { name: "tools", command: "bun", args: ["tools.ts"], env: [] }
    const docs = { name: "docs", command: "bun", args: ["docs.ts"], env: [] }

    const mcpFailure = await fixture.service
      .loadSession({ cwd: "/workspace", sessionId: session.sessionId, mcpServers: [tools, docs] })
      .catch((error: unknown) => error)
    const afterMcpFailure = await fixture.service.setSessionConfigOption({
      sessionId: session.sessionId,
      configId: "effort",
      value: "high",
    })

    phase = "commands"
    const commandFailure = await fixture.service
      .resumeSession({ cwd: "/workspace", sessionId: session.sessionId, mcpServers: [tools] })
      .catch((error: unknown) => error)
    const afterCommandFailure = await fixture.service.setSessionConfigOption({
      sessionId: session.sessionId,
      configId: "effort",
      value: "default",
    })

    phase = "replay"
    const replayFailure = await fixture.service
      .loadSession({ cwd: "/workspace", sessionId: session.sessionId, mcpServers: [tools] })
      .catch((error: unknown) => error)
    const afterReplayFailure = await fixture.service.setSessionConfigOption({
      sessionId: session.sessionId,
      configId: "effort",
      value: "high",
    })

    phase = "success"
    const attached = await fixture.service.resumeSession({
      cwd: "/workspace",
      sessionId: session.sessionId,
      mcpServers: [tools],
    })

    expect([mcpFailure, commandFailure, replayFailure]).toEqual([
      expect.any(Error),
      expect.any(Error),
      expect.any(Error),
    ])
    expect(currentValue(afterMcpFailure, "model")).toBe("test/test-model")
    expect(currentValue(afterCommandFailure, "model")).toBe("test/test-model")
    expect(currentValue(afterReplayFailure, "model")).toBe("test/test-model")
    expect(currentValue(attached, "model")).toBe("test/second-model")
    expect(
      fixture.requests
        .filter((request) => request.path.startsWith("/api/mcp/"))
        .map((request) => `${request.method} ${request.path}`),
    ).toEqual([
      "PUT /api/mcp/tools",
      "PUT /api/mcp/docs",
      "DELETE /api/mcp/tools",
      "DELETE /api/mcp/docs",
      "PUT /api/mcp/tools",
      "DELETE /api/mcp/tools",
      "PUT /api/mcp/tools",
    ])
  })

  test("serializes MCP attachment transactions for sessions in the same location", async () => {
    const firstStaged = Promise.withResolvers<void>()
    const releaseFirst = Promise.withResolvers<void>()
    let racing = false
    let created = 0
    let installed: unknown
    await using fixture = makeACPFixture({
      sessionUpdate: async (update) => {
        if (!racing || update.sessionId !== "ses_location_1") return
        firstStaged.resolve()
        await releaseFirst.promise
        throw new Error("first publication failed")
      },
      fetch(request) {
        if (request.method === "POST" && request.path === "/api/session") {
          created++
          return Response.json({ data: makeSession(`ses_location_${created}`) })
        }
        if (request.method === "GET" && request.path.startsWith("/api/session/ses_location_")) {
          return Response.json({ data: makeSession(request.path.split("/").at(-1) ?? "missing") })
        }
        if (request.method === "PUT" && request.path === "/api/mcp/shared") {
          installed = request.body
          return new Response(null, { status: 204 })
        }
        if (request.method === "DELETE" && request.path === "/api/mcp/shared") {
          installed = undefined
          return new Response(null, { status: 204 })
        }
        return undefined
      },
    })
    const first = await fixture.service.newSession({ cwd: "/workspace", mcpServers: [] })
    const second = await fixture.service.newSession({ cwd: "/workspace", mcpServers: [] })
    racing = true

    const failed = fixture.service
      .resumeSession({
        cwd: "/workspace",
        sessionId: first.sessionId,
        mcpServers: [{ name: "shared", command: "bun", args: ["first.ts"], env: [] }],
      })
      .catch((error: unknown) => error)
    await firstStaged.promise
    const succeeded = fixture.service.resumeSession({
      cwd: "/workspace",
      sessionId: second.sessionId,
      mcpServers: [{ name: "shared", command: "bun", args: ["second.ts"], env: [] }],
    })
    releaseFirst.resolve()

    expect(await failed).toBeInstanceOf(Error)
    await succeeded
    expect(installed).toEqual({
      config: { type: "local", command: ["bun", "second.ts"], environment: {} },
    })
    expect(
      fixture.requests
        .filter((request) => request.path === "/api/mcp/shared")
        .map((request) => ({ method: request.method, body: request.body })),
    ).toEqual([
      {
        method: "PUT",
        body: { config: { type: "local", command: ["bun", "first.ts"], environment: {} } },
      },
      { method: "DELETE", body: undefined },
      {
        method: "PUT",
        body: { config: { type: "local", command: ["bun", "second.ts"], environment: {} } },
      },
    ])
  })

  test("allows MCP attachment transactions in distinct locations to proceed concurrently", async () => {
    const firstStaged = Promise.withResolvers<void>()
    const releaseFirst = Promise.withResolvers<void>()
    let racing = false
    let created = 0
    await using fixture = makeACPFixture({
      sessionUpdate: async (update) => {
        if (!racing || update.sessionId !== "ses_distinct_1") return
        firstStaged.resolve()
        await releaseFirst.promise
      },
      fetch(request) {
        if (request.method === "POST" && request.path === "/api/session") {
          created++
          const cwd = created === 1 ? "/first" : "/second"
          return Response.json({ data: makeSession(`ses_distinct_${created}`, { cwd }) })
        }
        if (request.method === "GET" && request.path.startsWith("/api/session/ses_distinct_")) {
          const id = request.path.split("/").at(-1) ?? "missing"
          return Response.json({ data: makeSession(id, { cwd: id.endsWith("1") ? "/first" : "/second" }) })
        }
        if (request.method === "PUT" && request.path === "/api/mcp/shared") {
          return new Response(null, { status: 204 })
        }
        return undefined
      },
    })
    const first = await fixture.service.newSession({ cwd: "/first", mcpServers: [] })
    const second = await fixture.service.newSession({ cwd: "/second", mcpServers: [] })
    racing = true

    const blocked = fixture.service.resumeSession({
      cwd: "/first",
      sessionId: first.sessionId,
      mcpServers: [{ name: "shared", command: "bun", args: ["first.ts"], env: [] }],
    })
    await firstStaged.promise
    const concurrent = fixture.service.resumeSession({
      cwd: "/second",
      sessionId: second.sessionId,
      mcpServers: [{ name: "shared", command: "bun", args: ["second.ts"], env: [] }],
    })

    await withTimeout(concurrent, "distinct location transaction was blocked")
    releaseFirst.resolve()
    await blocked
  })

  test("allows config switches for distinct sessions to proceed concurrently", async () => {
    const firstStarted = Promise.withResolvers<void>()
    const releaseFirst = Promise.withResolvers<void>()
    let created = 0
    await using fixture = makeACPFixture({
      fetch(request) {
        if (request.method === "POST" && request.path === "/api/session") {
          created++
          return Response.json({ data: makeSession(`ses_concurrent_${created}`) })
        }
        if (request.method === "POST" && request.path === "/api/session/ses_concurrent_1/model") {
          firstStarted.resolve()
          return releaseFirst.promise.then(() => new Response(null, { status: 204 }))
        }
        if (request.method === "POST" && request.path === "/api/session/ses_concurrent_2/model") {
          return new Response(null, { status: 204 })
        }
        return undefined
      },
    })
    const first = await fixture.service.newSession({ cwd: "/workspace", mcpServers: [] })
    const second = await fixture.service.newSession({ cwd: "/workspace", mcpServers: [] })

    const blocked = fixture.service.setSessionConfigOption({
      sessionId: first.sessionId,
      configId: "effort",
      value: "high",
    })
    await firstStarted.promise
    const concurrent = await fixture.service.setSessionConfigOption({
      sessionId: second.sessionId,
      configId: "effort",
      value: "high",
    })
    releaseFirst.resolve()
    await blocked

    expect(currentValue(concurrent, "effort")).toBe("high")
  })

  test("load replacement cancels prompt ownership acquired before streaming", async () => {
    await using fixture = makeACPFixture({
      fetch(request, context) {
        if (request.method === "POST" && request.path === "/api/session") {
          return Response.json({ data: makeSession("ses_prompt_load") })
        }
        if (request.method === "GET" && request.path === "/api/session/ses_prompt_load") {
          return Response.json({ data: makeSession("ses_prompt_load") })
        }
        if (request.method === "GET" && request.path === "/api/session/ses_prompt_load/message") {
          return Response.json({ data: [], cursor: {} })
        }
        if (request.method === "POST" && request.path === "/api/session/ses_prompt_load/prompt") {
          const id = requestField(request.body, "id")
          context.send({
            id: `evt_${id}`,
            type: "session.inbox.delivered",
            data: { sessionID: "ses_prompt_load", inboxID: id },
          })
          if (requestField(request.body, "text") === "second") {
            context.send({
              id: "evt_second_complete",
              type: "session.execution.succeeded",
              data: { sessionID: "ses_prompt_load" },
            })
          }
          return Response.json({ data: {} })
        }
        return undefined
      },
    })
    const session = await fixture.service.newSession({ cwd: "/workspace", mcpServers: [] })

    const prompt = fixture.service.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "first" }],
    })
    const stoppedPrompt = prompt.then(
      () => "resolved",
      () => "rejected",
    )
    const loaded = fixture.service.loadSession({ cwd: "/workspace", sessionId: session.sessionId, mcpServers: [] })
    await loaded
    const stopped = await withTimeout(stoppedPrompt, "replaced prompt did not stop")
    const second = await fixture.service.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "second" }],
    })

    expect(stopped).toBe("rejected")
    expect(second.stopReason).toBe("end_turn")
  })

  test("replacement permits a new prompt while the retired request does not settle", async () => {
    const firstStarted = Promise.withResolvers<void>()
    const firstAborted = Promise.withResolvers<void>()
    const nativeFetch = fetch
    let prompts = 0
    await using fixture = makeACPFixture({
      clientFetch(input, init) {
        const url = new URL(input instanceof Request ? input.url : input.toString())
        if (init?.method !== "POST" || url.pathname !== "/api/session/ses_prompt_handoff/prompt") {
          return nativeFetch(input, init)
        }
        prompts++
        if (prompts > 1) return nativeFetch(input, init)
        firstStarted.resolve()
        init.signal?.addEventListener("abort", () => firstAborted.resolve(), { once: true })
        return new Promise<Response>(() => {})
      },
      fetch(request, context) {
        if (request.method === "POST" && request.path === "/api/session") {
          return Response.json({ data: makeSession("ses_prompt_handoff") })
        }
        if (request.method === "GET" && request.path === "/api/session/ses_prompt_handoff") {
          return Response.json({ data: makeSession("ses_prompt_handoff") })
        }
        if (request.method === "GET" && request.path === "/api/session/ses_prompt_handoff/message") {
          return Response.json({ data: [], cursor: {} })
        }
        if (request.method === "POST" && request.path === "/api/session/ses_prompt_handoff/prompt") {
          const id = requestField(request.body, "id")
          context.send({
            id: `evt_${id}`,
            type: "session.inbox.delivered",
            data: { sessionID: "ses_prompt_handoff", inboxID: id },
          })
          context.send({
            id: "evt_handoff_complete",
            type: "session.execution.succeeded",
            data: { sessionID: "ses_prompt_handoff" },
          })
          return Response.json({ data: {} })
        }
        return undefined
      },
    })
    const session = await fixture.service.newSession({ cwd: "/workspace", mcpServers: [] })
    void fixture.service
      .prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "never settles" }] })
      .catch(() => undefined)
    await firstStarted.promise

    await fixture.service.loadSession({ cwd: "/workspace", sessionId: session.sessionId, mcpServers: [] })
    await firstAborted.promise
    const current = await fixture.service.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "new owner" }],
    })

    expect(current.stopReason).toBe("end_turn")
    expect(prompts).toBe(2)
  })

  test("cancel permits a new prompt while the cancelled request does not settle", async () => {
    const firstStarted = Promise.withResolvers<void>()
    const firstAborted = Promise.withResolvers<void>()
    const nativeFetch = fetch
    let prompts = 0
    await using fixture = makeACPFixture({
      clientFetch(input, init) {
        const url = new URL(input instanceof Request ? input.url : input.toString())
        if (init?.method !== "POST" || url.pathname !== "/api/session/ses_prompt_cancel_handoff/prompt") {
          return nativeFetch(input, init)
        }
        prompts++
        if (prompts > 1) return nativeFetch(input, init)
        firstStarted.resolve()
        init.signal?.addEventListener("abort", () => firstAborted.resolve(), { once: true })
        return new Promise<Response>(() => {})
      },
      fetch(request, context) {
        if (request.method === "POST" && request.path === "/api/session") {
          return Response.json({ data: makeSession("ses_prompt_cancel_handoff") })
        }
        if (request.method === "POST" && request.path === "/api/session/ses_prompt_cancel_handoff/interrupt") {
          return Response.json({ interrupted: true })
        }
        if (request.method === "POST" && request.path === "/api/session/ses_prompt_cancel_handoff/prompt") {
          const id = requestField(request.body, "id")
          context.send({
            id: `evt_${id}`,
            type: "session.inbox.delivered",
            data: { sessionID: "ses_prompt_cancel_handoff", inboxID: id },
          })
          context.send({
            id: "evt_cancel_handoff_complete",
            type: "session.execution.succeeded",
            data: { sessionID: "ses_prompt_cancel_handoff" },
          })
          return Response.json({ data: {} })
        }
        return undefined
      },
    })
    const session = await fixture.service.newSession({ cwd: "/workspace", mcpServers: [] })
    void fixture.service
      .prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "never settles" }] })
      .catch(() => undefined)
    await firstStarted.promise

    await fixture.service.cancel({ sessionId: session.sessionId })
    await firstAborted.promise
    const current = await fixture.service.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "new owner" }],
    })

    expect(current.stopReason).toBe("end_turn")
    expect(prompts).toBe(2)
  })

  test("delete detaches and cancels an active foreground prompt", async () => {
    const promptStarted = Promise.withResolvers<void>()
    await using fixture = makeACPFixture({
      fetch(request, context) {
        if (request.method === "POST" && request.path === "/api/session") {
          return Response.json({ data: makeSession("ses_prompt_delete") })
        }
        if (request.method === "POST" && request.path === "/api/session/ses_prompt_delete/prompt") {
          const id = requestField(request.body, "id")
          context.send({
            id: `evt_${id}`,
            type: "session.inbox.delivered",
            data: { sessionID: "ses_prompt_delete", inboxID: id },
          })
          promptStarted.resolve()
          return Response.json({ data: {} })
        }
        if (request.method === "POST" && request.path === "/api/session/ses_prompt_delete/model") {
          return new Response(null, { status: 204 })
        }
        if (request.method === "DELETE" && request.path === "/api/session/ses_prompt_delete") {
          return new Response(null, { status: 204 })
        }
        return undefined
      },
    })
    const session = await fixture.service.newSession({ cwd: "/workspace", mcpServers: [] })
    const prompt = fixture.service.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "running" }],
    })
    const stoppedPrompt = prompt.then(
      () => "resolved",
      () => "rejected",
    )
    await promptStarted.promise

    const configured = await fixture.service.setSessionConfigOption({
      sessionId: session.sessionId,
      configId: "effort",
      value: "high",
    })
    await fixture.service.deleteSession({ sessionId: session.sessionId })
    const stopped = await withTimeout(stoppedPrompt, "deleted session prompt did not stop")

    expect(currentValue(configured, "effort")).toBe("high")
    expect(stopped).toBe("rejected")
  })

  test("lists server-backed pages and forwards cwd and cursor", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) =>
      makeSession(`ses_${100 - index}`, {
        cwd: "/workspace",
        time: { created: index, updated: 100_000 - index },
        title: `Session ${100 - index}`,
      }),
    )
    await using fixture = makeACPFixture({
      fetch(request) {
        if (request.method !== "GET" || request.path !== "/api/session") return undefined
        if (request.query.cursor === "page-2") {
          return Response.json({
            data: [makeSession("ses_0", { cwd: "/workspace", time: { created: 0, updated: 1 } })],
            cursor: {},
          })
        }
        return Response.json({ data: firstPage, cursor: { next: "page-2" } })
      },
    })

    const first = await fixture.service.listSessions({ cwd: "/workspace" })
    const second = await fixture.service.listSessions({ cwd: "/workspace", cursor: first.nextCursor })

    expect(first.sessions).toHaveLength(100)
    expect(first.sessions[0]).toEqual({
      sessionId: "ses_100",
      cwd: "/workspace",
      title: "Session 100",
      updatedAt: new Date(100_000).toISOString(),
    })
    expect(first.nextCursor).toBe("page-2")
    expect(second.sessions.map((session) => session.sessionId)).toEqual(["ses_0"])
    expect(second.nextCursor).toBeUndefined()
    expect(
      fixture.requests.filter((request) => request.path === "/api/session").map((request) => request.query),
    ).toEqual([
      { limit: "100", order: "desc", directory: "/workspace" },
      { limit: "100", order: "desc", directory: "/workspace", cursor: "page-2" },
    ])
  })

  test("cancel preserves the attachment while close removes it and interrupts best-effort", async () => {
    await using fixture = makeACPFixture({
      fetch(request) {
        if (request.method === "POST" && request.path === "/api/session") {
          return Response.json({ data: makeSession("ses_lifecycle") })
        }
        if (request.method === "POST" && request.path === "/api/session/ses_lifecycle/model") {
          return new Response(null, { status: 204 })
        }
        if (request.method === "POST" && request.path.endsWith("/interrupt")) {
          return new Response(null, { status: 500 })
        }
        return undefined
      },
    })
    const created = await fixture.service.newSession({ cwd: "/workspace", mcpServers: [] })

    await fixture.service.cancel({ sessionId: created.sessionId })
    const updated = await fixture.service.setSessionConfigOption({
      sessionId: created.sessionId,
      configId: "effort",
      value: "high",
    })

    expect(currentValue(updated, "effort")).toBe("high")
    expect(await fixture.service.closeSession({ sessionId: created.sessionId })).toEqual({})
    const missing = await fixture.service
      .setSessionConfigOption({
        sessionId: created.sessionId,
        configId: "effort",
        value: "default",
      })
      .catch((error: unknown) => error)
    expect(missing).toMatchObject({ _tag: "ACPSessionNotFoundError", sessionId: created.sessionId })
    expect(await fixture.service.closeSession({ sessionId: "missing" })).toEqual({})
    expect(
      fixture.requests.filter((request) => request.path.endsWith("/interrupt")).map((request) => request.path),
    ).toEqual([
      "/api/session/ses_lifecycle/interrupt",
      "/api/session/ses_lifecycle/interrupt",
      "/api/session/missing/interrupt",
    ])
  })

  test("deletes sessions from backing and local storage", async () => {
    await using fixture = makeACPFixture({
      fetch(request) {
        if (request.method === "POST" && request.path === "/api/session") {
          return Response.json({ data: makeSession("ses_delete") })
        }
        if (request.method === "DELETE" && request.path === "/api/session/ses_delete") {
          return new Response(null, { status: 204 })
        }
        return undefined
      },
    })
    const session = await fixture.service.newSession({ cwd: "/workspace", mcpServers: [] })

    expect(await fixture.service.deleteSession({ sessionId: session.sessionId })).toEqual({})
    expect(fixture.requests).toContainEqual({
      method: "DELETE",
      path: "/api/session/ses_delete",
      query: {},
      body: undefined,
    })
    const missing = await fixture.service
      .setSessionConfigOption({ sessionId: session.sessionId, configId: "effort", value: "high" })
      .catch((error: unknown) => error)
    expect(missing).toMatchObject({ _tag: "ACPSessionNotFoundError", sessionId: session.sessionId })
  })
})

function currentValue(result: { readonly configOptions?: readonly SessionConfigOption[] | null }, id: string) {
  return result.configOptions?.find((option) => option.id === id)?.currentValue
}

function requestField(value: unknown, key: string) {
  if (!value || typeof value !== "object") throw new Error(`Missing request ${key}`)
  const field = Reflect.get(value, key)
  if (typeof field !== "string") throw new Error(`Missing request ${key}`)
  return field
}
