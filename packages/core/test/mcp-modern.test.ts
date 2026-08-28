import { expect } from "bun:test"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { createMcpHandler, inputRequired, Server } from "@modelcontextprotocol/server"
import { JSONRPCMessageSchema } from "@modelcontextprotocol/core"
import { McpClient } from "@opencode-ai/core/mcp/client"
import { ConfigMCP } from "@opencode-ai/schema/config/mcp"
import { Deferred, Effect, Exit, Fiber } from "effect"
import { testEffect } from "./lib/effect"
import { hostEnvironmentLayer } from "./fixture/environment"

const it = testEffect(hostEnvironmentLayer)

function modernServer(legacy: "reject" | "stateless" = "reject", listen?: (request: Request) => Promise<Response>) {
  return Effect.gen(function* () {
    const requests: Array<{ method: string; headers: Headers; params: unknown }> = []
    const state = { tool: "echo", calls: 0, started: Promise.withResolvers<AbortSignal>() }
    const handler = createMcpHandler(
      () => {
        const server = new Server(
          { name: "modern-test", version: "1.0.0" },
          {
            instructions: "Modern server instructions",
            capabilities: {
              logging: {},
              tools: { listChanged: true },
              prompts: { listChanged: true },
              resources: { listChanged: true },
            },
          },
        )
        server.setRequestHandler("tools/list", async () => ({
          ttlMs: 60_000,
          tools: [
            {
              name: state.tool,
              inputSchema: { type: "object", properties: { value: { type: "string", "x-mcp-header": "Value" } } },
              outputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
            },
            { name: "confirm", inputSchema: { type: "object" } },
          ],
        }))
        server.setRequestHandler("tools/call", async (request, ctx) => {
          if (request.params.name === "wait") {
            state.started.resolve(ctx.mcpReq.signal)
            await new Promise<void>((resolve) =>
              ctx.mcpReq.signal.addEventListener("abort", () => resolve(), { once: true }),
            )
            return { content: [] }
          }
          if (request.params.name === "urls") {
            if (!ctx.mcpReq.inputResponses)
              return inputRequired({
                inputRequests: {
                  first: inputRequired.elicitUrl({ message: "First", url: "https://example.com/first" }),
                  second: inputRequired.elicitUrl({ message: "Second", url: "https://example.com/second" }),
                },
              })
            return { content: [], structuredContent: ctx.mcpReq.inputResponses }
          }
          if (request.params.name === "confirm") {
            if (!ctx.mcpReq.inputResponses)
              return inputRequired({
                inputRequests: {
                  roots: inputRequired.listRoots(),
                  confirm: inputRequired.elicit({
                    message: "Continue?",
                    requestedSchema: { type: "object", properties: { approved: { type: "boolean" } } },
                  }),
                },
              })
            state.calls++
            return { content: [], structuredContent: ctx.mcpReq.inputResponses }
          }
          state.calls++
          await ctx.mcpReq.notify({ method: "notifications/message", params: { level: "info", data: "called" } })
          return { content: [], structuredContent: { value: request.params.arguments?.value ?? "hello" } }
        })
        server.setRequestHandler("prompts/list", async () => ({ prompts: [{ name: "greet" }] }))
        server.setRequestHandler("prompts/get", async () => ({
          messages: [{ role: "user", content: { type: "text", text: "Hello" } }],
        }))
        server.setRequestHandler("resources/list", async () => ({
          resources: [{ name: "readme", uri: "docs://readme" }],
        }))
        server.setRequestHandler("resources/templates/list", async () => ({
          resourceTemplates: [{ name: "document", uriTemplate: "docs://{name}" }],
        }))
        server.setRequestHandler("resources/read", async () => ({
          contents: [{ uri: "docs://readme", text: "Read me" }],
        }))
        return server
      },
      { legacy },
    )
    yield* Effect.addFinalizer(() => Effect.promise(() => handler.close()))
    const http = yield* Effect.acquireRelease(
      Effect.sync(() =>
        Bun.serve({
          port: 0,
          async fetch(request) {
            if (request.method === "POST") {
              const message = JSONRPCMessageSchema.parse(await request.clone().json())
              if ("method" in message)
                requests.push({ method: message.method, headers: request.headers, params: message.params })
              if ("method" in message && message.method === "subscriptions/listen" && listen) return listen(request)
            }
            return handler.fetch(request)
          },
        }),
      ),
      (server) => Effect.sync(() => server.stop(true)),
    )
    return { handler, requests, state, url: http.url.href }
  })
}

for (const legacy of ["reject", "stateless"] as const) {
  it.live(`uses modern HTTP against a ${legacy === "reject" ? "modern-only" : "dual-era"} server`, () =>
    Effect.gen(function* () {
      const server = yield* modernServer(legacy)
      const connection = yield* McpClient.connect(
        "modern",
        new ConfigMCP.Remote({ type: "remote", url: server.url, oauth: false }),
        import.meta.dir,
      )
      expect(connection.instructions).toBe("Modern server instructions")
      expect((yield* connection.tools()).map((tool) => tool.name)).toEqual(["echo", "confirm"])
      const logs: McpClient.LogMessage[] = []
      connection.onLog((message) => logs.push(message))
      expect(yield* connection.callTool({ name: "echo", args: { value: "hello" } })).toMatchObject({
        structured: { value: "hello" },
      })
      expect(logs).toContainEqual({ level: "info", data: "called" })
      expect((yield* connection.callTool({ name: "echo", args: { value: 42 } }).pipe(Effect.flip)).message).toContain(
        "output schema",
      )
      expect(server.state.calls).toBe(2)
      expect((yield* connection.prompts()).map((prompt) => prompt.name)).toEqual(["greet"])
      expect((yield* connection.prompt({ name: "greet" })).messages).toHaveLength(1)
      expect((yield* connection.resources()).map((resource) => resource.uri)).toEqual(["docs://readme"])
      expect((yield* connection.resourceTemplates()).map((template) => template.uriTemplate)).toEqual(["docs://{name}"])
      expect(yield* connection.readResource({ uri: "docs://readme" })).toMatchObject({
        contents: [{ text: "Read me" }],
      })
      expect(server.requests[0]?.method).toBe("server/discover")
      expect(server.requests.some((request) => request.method === "initialize")).toBe(false)
      expect(server.requests.every((request) => request.headers.get("mcp-protocol-version") === "2026-07-28")).toBe(
        true,
      )
      expect(server.requests.every((request) => !request.headers.has("mcp-session-id"))).toBe(true)
      expect(server.requests.find((request) => request.method === "tools/call")?.headers.get("mcp-param-value")).toBe(
        "hello",
      )
    }),
  )
}

it.live("handles modern roots and elicitation without duplicating the final tool action", () =>
  Effect.gen(function* () {
    const server = yield* modernServer()
    const prompts: string[] = []
    const connection = yield* McpClient.connect(
      "modern",
      new ConfigMCP.Remote({ type: "remote", url: server.url, oauth: false }),
      import.meta.dir,
      undefined,
      {
        create: (input) => {
          prompts.push(input.params.message)
          return Effect.succeed({ action: "accept", content: { approved: true } })
        },
        complete: () => Effect.void,
      },
    )
    yield* connection.tools()
    expect((yield* connection.callTool({ name: "confirm" })).structured).toMatchObject({
      roots: { roots: [{ uri: pathToFileURL(import.meta.dir).href }] },
      confirm: { action: "accept", content: { approved: true } },
    })
    expect(prompts).toEqual(["Continue?"])
    expect(server.state.calls).toBe(1)
    expect(server.requests.filter((request) => request.method === "tools/call")).toHaveLength(2)
  }),
)

it.live("receives modern catalog subscriptions and refreshes the tool definitions", () =>
  Effect.gen(function* () {
    const server = yield* modernServer()
    const connection = yield* McpClient.connect(
      "modern",
      new ConfigMCP.Remote({ type: "remote", url: server.url, oauth: false }),
      import.meta.dir,
    )
    yield* connection.tools()
    const tools = yield* Deferred.make<void>()
    const prompts = yield* Deferred.make<void>()
    const resources = yield* Deferred.make<void>()
    connection.onToolsChanged(() => Deferred.doneUnsafe(tools, Exit.void))
    connection.onPromptsChanged(() => Deferred.doneUnsafe(prompts, Exit.void))
    connection.onResourcesChanged(() => Deferred.doneUnsafe(resources, Exit.void))
    server.state.tool = "updated"
    server.handler.notify.toolsChanged()
    server.handler.notify.promptsChanged()
    server.handler.notify.resourcesChanged()
    yield* Effect.all([Deferred.await(tools), Deferred.await(prompts), Deferred.await(resources)]).pipe(
      Effect.timeout("2 seconds"),
    )
    expect((yield* connection.tools()).map((tool) => tool.name)).toEqual(["updated", "confirm"])
    expect(server.requests.some((request) => request.method === "subscriptions/listen")).toBe(true)
  }),
)

it.live("gives simultaneous modern URL elicitations independent local identities", () =>
  Effect.gen(function* () {
    const server = yield* modernServer()
    const identities: string[] = []
    const connection = yield* McpClient.connect(
      "modern",
      new ConfigMCP.Remote({ type: "remote", url: server.url, oauth: false }),
      import.meta.dir,
      undefined,
      {
        create: (input) => {
          if (input.params.mode === "url") identities.push(input.params.elicitationId)
          return Effect.succeed({ action: "accept" })
        },
        complete: () => Effect.die("Modern URL elicitation has no legacy completion notification"),
      },
    )
    expect((yield* connection.callTool({ name: "urls" })).structured).toEqual({
      first: { action: "accept" },
      second: { action: "accept" },
    })
    expect(identities).toHaveLength(2)
    expect(identities.every((id) => typeof id === "string" && id.length > 0)).toBe(true)
    expect(new Set(identities).size).toBe(2)
  }),
)

it.live("cancels modern HTTP work by closing its response stream", () =>
  Effect.gen(function* () {
    const server = yield* modernServer()
    const connection = yield* McpClient.connect(
      "modern",
      new ConfigMCP.Remote({ type: "remote", url: server.url, oauth: false }),
      import.meta.dir,
    )
    const call = yield* connection.callTool({ name: "wait" }).pipe(Effect.forkScoped)
    const signal = yield* Effect.promise(() => server.state.started.promise)
    const cancelled = new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))
    yield* Fiber.interrupt(call)
    yield* Effect.promise(() => cancelled).pipe(Effect.timeout("2 seconds"))
    expect(signal.aborted).toBe(true)
    expect(server.requests.some((request) => request.method === "notifications/cancelled")).toBe(false)
  }),
)

it.live("replaces ended modern subscriptions and stops them when the connection scope closes", () =>
  Effect.gen(function* () {
    const opened = Promise.withResolvers<void>()
    const cancelled = Promise.withResolvers<void>()
    const streams: Array<{ id: string | number; controller: ReadableStreamDefaultController<Uint8Array> }> = []
    const server = yield* modernServer("reject", async (request) => {
      const message = JSONRPCMessageSchema.parse(await request.json())
      if (!("id" in message) || !("method" in message)) return new Response(null, { status: 400 })
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            streams.push({ id: message.id, controller })
            controller.enqueue(
              new TextEncoder().encode(
                `data: ${JSON.stringify({
                  jsonrpc: "2.0",
                  method: "notifications/subscriptions/acknowledged",
                  params: {
                    notifications: message.params?.notifications,
                    _meta: { "io.modelcontextprotocol/subscriptionId": message.id },
                  },
                })}\n\n`,
              ),
            )
            if (streams.length === 2) {
              opened.resolve()
              request.signal.addEventListener("abort", () => cancelled.resolve(), { once: true })
            }
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      )
    })
    yield* Effect.scoped(
      Effect.gen(function* () {
        const connection = yield* McpClient.connect(
          "modern",
          new ConfigMCP.Remote({ type: "remote", url: server.url, oauth: false }),
          import.meta.dir,
        )
        const changed = yield* Deferred.make<void>()
        const restored = yield* Deferred.make<void>()
        let updates = 0
        connection.onToolsChanged(() => {
          updates++
          Deferred.doneUnsafe(updates === 1 ? restored : changed, Exit.void)
        })
        const first = streams[0]
        if (!first) throw new Error("Missing initial subscription")
        expect((yield* connection.tools())[0]?.name).toBe("echo")
        first.controller.close()
        server.state.tool = "changed-during-disconnect"
        yield* Effect.promise(() => opened.promise).pipe(Effect.timeout("3 seconds"))
        yield* Deferred.await(restored).pipe(Effect.timeout("1 second"))
        expect((yield* connection.tools())[0]?.name).toBe("changed-during-disconnect")
        const second = streams[1]
        if (!second) throw new Error("Missing replacement subscription")
        second.controller.enqueue(
          new TextEncoder().encode(
            `data: ${JSON.stringify({
              jsonrpc: "2.0",
              method: "notifications/tools/list_changed",
              params: { _meta: { "io.modelcontextprotocol/subscriptionId": second.id } },
            })}\n\n`,
          ),
        )
        yield* Deferred.await(changed).pipe(Effect.timeout("1 second"))
      }),
    )
    yield* Effect.promise(() => cancelled.promise).pipe(Effect.timeout("1 second"))
    yield* Effect.sleep("1100 millis")
    expect(streams).toHaveLength(2)
  }),
)

it.live("uses modern stdio subscriptions and roots through the location transport", () =>
  Effect.gen(function* () {
    const connection = yield* McpClient.connect(
      "modern-stdio",
      new ConfigMCP.Local({
        type: "local",
        command: [process.execPath, path.join(import.meta.dir, "fixture/mcp-modern-stdio.ts")],
      }),
      import.meta.dir,
    )
    expect(connection.instructions).toBe("Modern stdio instructions")
    expect((yield* connection.tools()).map((tool) => tool.name)).toEqual(["initial"])
    const changed = yield* Deferred.make<void>()
    connection.onToolsChanged(() => Deferred.doneUnsafe(changed, Exit.void))
    expect((yield* connection.callTool({ name: "initial" })).structured).toMatchObject({
      roots: { roots: [{ uri: pathToFileURL(import.meta.dir).href }] },
    })
    yield* Deferred.await(changed).pipe(Effect.timeout("1 second"))
    expect((yield* connection.tools()).map((tool) => tool.name)).toEqual(["updated"])
  }),
)

for (const stop of ["interrupt", "timeout"] as const) {
  it.live(`closes an HTTP discovery probe on startup ${stop}`, () =>
    Effect.gen(function* () {
      const received = Promise.withResolvers<void>()
      const abandoned = Promise.withResolvers<void>()
      const server = yield* Effect.acquireRelease(
        Effect.sync(() =>
          Bun.serve({
            port: 0,
            async fetch(request) {
              received.resolve()
              await new Promise<void>((resolve) =>
                request.signal.addEventListener("abort", () => resolve(), { once: true }),
              )
              abandoned.resolve()
              return new Response(null, { status: 503 })
            },
          }),
        ),
        (server) => Effect.sync(() => server.stop(true)),
      )
      const connecting = yield* McpClient.connect(
        "discovery-cancel",
        new ConfigMCP.Remote({ type: "remote", url: server.url.href, oauth: false, timeout: { startup: 200 } }),
        import.meta.dir,
      ).pipe(Effect.forkScoped)
      yield* Effect.promise(() => received.promise)
      if (stop === "interrupt") yield* Fiber.interrupt(connecting)
      if (stop === "timeout") expect(Exit.isFailure(yield* Fiber.await(connecting))).toBe(true)
      yield* Effect.promise(() => abandoned.promise).pipe(Effect.timeout("1 second"))
    }),
  )
}
