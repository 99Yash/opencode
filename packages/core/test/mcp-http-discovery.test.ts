import { describe, expect, test } from "bun:test"
import { createRequire } from "node:module"
import { JSONRPCMessageSchema } from "@modelcontextprotocol/core"
import {
  Client,
  MissingRequiredClientCapabilityError,
  ProtocolError,
  SdkErrorCode,
  StreamableHTTPClientTransport,
  type ClientOptions,
  type StreamableHTTPClientTransportOptions,
} from "@modelcontextprotocol/client"

const modern = "2026-07-28"
const legacy = "2025-11-25"
const discovery = { supportedVersions: [modern], capabilities: { tools: {} } }

type Message = { id?: string | number; method: string; params?: Record<string, unknown> }

function fixture(
  respond: (message: Message, request: Request) => Response | undefined | Promise<Response | undefined>,
  options: ClientOptions = {},
  transportOptions: StreamableHTTPClientTransportOptions = {},
  sdk = { Client, StreamableHTTPClientTransport },
) {
  const requests: Array<{ message: Message; headers: Headers }> = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.method !== "POST") return new Response(null, { status: 405 })
      const message = JSONRPCMessageSchema.parse(await request.json())
      if (!("method" in message)) return new Response(null, { status: 400 })
      requests.push({ message, headers: request.headers })
      const response = await respond(message, request)
      if (response) return response
      if (message.method === "initialize" && "id" in message) {
        return Response.json(
          {
            jsonrpc: "2.0",
            id: message.id,
            result: {
              protocolVersion: legacy,
              capabilities: { tools: {} },
              serverInfo: { name: "legacy-http", version: "1" },
            },
          },
          { headers: { "mcp-session-id": "legacy-session" } },
        )
      }
      if (message.method === "tools/call" && "id" in message) {
        return Response.json({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "once" }] } })
      }
      return new Response(null, { status: 202 })
    },
  })
  const client = new sdk.Client(
    { name: "http-discovery-regression", version: "1" },
    { versionNegotiation: { mode: "auto", probe: { timeoutMs: 1_000 } }, ...options },
  )
  const transport = new sdk.StreamableHTTPClientTransport(server.url, transportOptions)
  return {
    client,
    transport,
    requests,
    async [Symbol.asyncDispose]() {
      await client.close()
      await transport.close()
      await server.stop(true)
    },
  }
}

describe("HTTP discovery compatibility", () => {
  test.each([true, false])("CommonJS modern=%s negotiates the same as ESM", async (supported) => {
    const sdk: { Client: typeof Client; StreamableHTTPClientTransport: typeof StreamableHTTPClientTransport } =
      createRequire(import.meta.url)("@modelcontextprotocol/client")
    await using server = fixture(
      (message) => {
        if (message.method !== "server/discover") return undefined
        return Response.json(
          supported
            ? { jsonrpc: "2.0", id: message.id, result: discovery }
            : { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse Error" } },
        )
      },
      {},
      {},
      sdk,
    )
    await server.client.connect(server.transport)
    expect(server.transport.protocolVersion).toBe(supported ? modern : legacy)
    expect(server.requests.map((request) => request.message.method)).toEqual(
      supported ? ["server/discover"] : ["server/discover", "initialize", "notifications/initialized"],
    )
  })

  test.each([
    [
      "null-id parse error",
      () => Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse Error" } }),
    ],
    ["missing-id error", () => Response.json({ jsonrpc: "2.0", error: { code: -32600, message: "Invalid Request" } })],
    ["malformed JSON", () => new Response("{", { headers: { "content-type": "application/json" } })],
    ["non-JSON 200", () => new Response("Legacy endpoint")],
    ["202", () => new Response(null, { status: 202 })],
    [
      "202 with SSE content type",
      () => new Response(null, { status: 202, headers: { "content-type": "text/event-stream" } }),
    ],
    ["204", () => new Response(null, { status: 204 })],
    ["invalid discovery result", (message: Message) => Response.json({ jsonrpc: "2.0", id: message.id, result: {} })],
    ["unmatched reply", () => Response.json({ jsonrpc: "2.0", id: "other", result: discovery })],
    [
      "method not found",
      (message: Message) =>
        Response.json({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } }),
    ],
  ] satisfies Array<[string, (message: Message) => Response]>)(
    "%s falls back immediately and calls a tool once",
    async (_, respond) => {
      await using server = fixture((message) => (message.method === "server/discover" ? respond(message) : undefined))
      await server.client.connect(server.transport)
      expect(server.transport.protocolVersion).toBe(legacy)
      expect(await server.client.callTool({ name: "once", arguments: {} })).toMatchObject({
        content: [{ type: "text", text: "once" }],
      })
      expect(server.requests.map((request) => request.message.method)).toEqual([
        "server/discover",
        "initialize",
        "notifications/initialized",
        "tools/call",
      ])
      expect(server.requests[0]?.headers.get("mcp-protocol-version")).toBe(modern)
      expect(server.requests[1]?.headers.has("mcp-session-id")).toBe(false)
      expect(server.requests[1]?.headers.has("mcp-protocol-version")).toBe(false)
      expect(server.requests[1]?.message.params).not.toHaveProperty("_meta")
      expect(server.requests[3]?.headers.get("mcp-session-id")).toBe("legacy-session")
    },
  )

  test.each([401, 403, 500, 503])("HTTP %i remains an error without initialize", async (status) => {
    await using server = fixture(() => new Response("Unavailable", { status }))
    await expect(server.client.connect(server.transport)).rejects.toMatchObject({ data: { status } })
    expect(server.requests.map((request) => request.message.method)).toEqual(["server/discover"])
  })

  test.each(["token", "onUnauthorized"] as const)("auth %s TypeError preserves identity", async (seam) => {
    const failure = new TypeError("Authentication callback failed")
    await using server = fixture(
      () => new Response(null, { status: 401 }),
      {},
      {
        authProvider: {
          token: async () => {
            if (seam === "token") throw failure
            return "expired"
          },
          onUnauthorized: async () => {
            throw failure
          },
        },
      },
    )
    await expect(server.client.connect(server.transport)).rejects.toBe(failure)
    expect(server.requests.some((request) => request.message.method === "initialize")).toBe(false)
  })

  test("real network failure remains an error", async () => {
    const endpoint = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null) })
    const url = endpoint.url
    await endpoint.stop(true)
    const client = new Client({ name: "network-failure", version: "1" }, { versionNegotiation: { mode: "auto" } })
    const transport = new StreamableHTTPClientTransport(url)
    try {
      await expect(client.connect(transport)).rejects.toMatchObject({ code: SdkErrorCode.EraNegotiationFailed })
    } finally {
      await client.close()
      await transport.close()
    }
  })

  test("HTTP discovery timeout does not initialize", async () => {
    await using server = fixture(() => new Promise<Response>(() => {}), {
      versionNegotiation: { mode: "auto", probe: { timeoutMs: 30 } },
    })
    await expect(server.client.connect(server.transport)).rejects.toMatchObject({ code: SdkErrorCode.RequestTimeout })
    expect(server.requests.map((request) => request.message.method)).toEqual(["server/discover"])
  })

  test("truncated HTTP response body remains a network error", async () => {
    const requests: string[] = []
    const endpoint = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        data(socket, data) {
          requests.push(data.toString())
          socket.end("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{")
        },
      },
    })
    const client = new Client({ name: "body-read-failure", version: "1" }, { versionNegotiation: { mode: "auto" } })
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${endpoint.port}`))
    try {
      await expect(client.connect(transport)).rejects.toMatchObject({ code: SdkErrorCode.EraNegotiationFailed })
      expect(requests).toHaveLength(1)
      expect(requests[0]).toContain("server/discover")
    } finally {
      await client.close()
      await transport.close()
      endpoint.stop(true)
    }
  })

  test.each([200, 400])("HTTP %i null-id modern error still corrects the offered version", async (status) => {
    const offers: Array<string | null> = []
    await using server = fixture(
      (message, request) => {
        offers.push(request.headers.get("mcp-protocol-version"))
        if (offers.length === 1) {
          return Response.json(
            {
              jsonrpc: "2.0",
              id: null,
              error: {
                code: -32022,
                message: "Unsupported version",
                data: { supported: [modern], requested: "2027-01-01" },
              },
            },
            { status },
          )
        }
        return Response.json({ jsonrpc: "2.0", id: message.id, result: discovery })
      },
      { supportedProtocolVersions: ["2027-01-01", modern, legacy] },
    )
    await server.client.connect(server.transport)
    expect(offers).toEqual(["2027-01-01", modern])
    expect(server.transport.protocolVersion).toBe(modern)
    expect(server.requests.map((request) => request.message.method)).toEqual(["server/discover", "server/discover"])
  })

  test("modern error with no shared version is not treated as legacy", async () => {
    await using server = fixture(() =>
      Response.json({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32022, message: "Unsupported version", data: { supported: ["2027-01-01"] } },
      }),
    )
    await expect(server.client.connect(server.transport)).rejects.toMatchObject({ code: -32022 })
    expect(server.requests.map((request) => request.message.method)).toEqual(["server/discover"])
  })

  test.each(
    [-32020, -32021].flatMap((code) =>
      [200, 400].flatMap((status) => [false, true].map((malformed) => ({ code, status, malformed }))),
    ),
  )("modern rejection %j never falls back", async ({ code, status, malformed }) => {
    const data = code === -32021 ? { requiredCapabilities: { sampling: {} } } : { header: "mcp-protocol-version" }
    await using server = fixture((message) =>
      Response.json(
        {
          jsonrpc: "2.0",
          id: malformed ? null : message.id,
          error: { code, message: "Modern request rejected", data },
        },
        { status },
      ),
    )
    const connected = server.client.connect(server.transport)
    await expect(connected).rejects.toBeInstanceOf(
      code === -32021 ? MissingRequiredClientCapabilityError : ProtocolError,
    )
    await expect(connected).rejects.toMatchObject({ code, message: "Modern request rejected", data })
    expect(server.requests.map((request) => request.message.method)).toEqual(["server/discover"])
  })

  test.each([404, 200])("modern tool HTTP %i failure does not initialize or repeat the call", async (status) => {
    await using server = fixture((message) => {
      if (message.method === "server/discover") {
        return Response.json(
          { jsonrpc: "2.0", id: message.id, result: discovery },
          {
            headers: { "mcp-session-id": "must-not-adopt" },
          },
        )
      }
      return status === 404
        ? new Response("Missing", { status })
        : Response.json({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32700, message: "Parse Error" },
          })
    })
    await server.client.connect(server.transport)
    expect(server.transport.protocolVersion).toBe(modern)
    expect(server.transport.sessionId).toBeUndefined()
    await expect(server.client.callTool({ name: "once", arguments: {} })).rejects.toBeInstanceOf(Error)
    expect(server.requests.map((request) => request.message.method)).toEqual(["server/discover", "tools/call"])
    expect(server.requests[1]?.headers.has("mcp-session-id")).toBe(false)
  })
})
