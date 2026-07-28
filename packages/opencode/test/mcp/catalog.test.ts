import { describe, expect, test } from "bun:test"
import { Client, InMemoryTransport } from "@modelcontextprotocol/client"
import { Server } from "@modelcontextprotocol/server"
import { McpCatalog } from "@/mcp/catalog"
import { CLIENT_OPTIONS } from "@/mcp"
import { Effect } from "effect"

const options = { toolCallId: "call_mcp", abortSignal: new AbortController().signal } as any

function clientReturning(result: unknown) {
  return {
    callTool: async () => result,
  } as unknown as Client
}

function mcpTool() {
  return {
    name: "screenshot",
    description: "Take a screenshot",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  } as any
}

describe("McpCatalog.convertTool", () => {
  test("preserves content when structuredContent is also present", async () => {
    const content = [{ type: "image" as const, mimeType: "image/png", data: "AAAA" }]
    const structuredContent = { image: { mimeType: "image/png", data: "AAAA" } }
    const converted = McpCatalog.convertTool({
      def: mcpTool(),
      client: clientReturning({ content, structuredContent }),
    })

    const output = await converted.execute?.({}, options)

    expect(output).toMatchObject({ content, structuredContent })
  })

  test("falls back to structuredContent only when content is absent", async () => {
    const structuredContent = { results: [{ title: "one" }] }
    const converted = McpCatalog.convertTool({
      def: mcpTool(),
      client: clientReturning({ content: [], structuredContent }),
    })

    const output = await converted.execute?.({}, options)

    expect(output).toMatchObject({
      structuredContent,
      content: [{ type: "text", text: JSON.stringify(structuredContent) }],
    })
  })
})

describe("McpCatalog.callTool", () => {
  test("forwards the request options", async () => {
    const controller = new AbortController()
    let request: unknown
    let options: unknown
    const client = {
      callTool: async (input: unknown, config: unknown) => {
        request = input
        options = config
        return { content: [] }
      },
    } as unknown as Client

    await McpCatalog.callTool({ def: mcpTool(), client, timeout: 123 }, { value: true }, controller.signal)

    expect(request).toEqual({ name: "screenshot", arguments: { value: true } })
    expect(options).toMatchObject({ resetTimeoutOnProgress: true, signal: controller.signal, timeout: 123 })
    expect(typeof (options as { onprogress?: unknown }).onprogress).toBe("function")
  })

  test("throws text returned by an MCP tool error", async () => {
    const client = clientReturning({
      isError: true,
      content: [
        { type: "image", data: "AAAA", mimeType: "image/png" },
        { type: "text", text: "first" },
        { type: "text", text: "second" },
      ],
    })

    await expect(McpCatalog.callTool({ def: mcpTool(), client }, {})).rejects.toThrow("first\n\nsecond")
  })
})

test("preserves output schema validation across paginated tool discovery", async () => {
  const server = new Server({ name: "pagination", version: "1.0.0" }, { capabilities: { tools: {} } })
  server.setRequestHandler("tools/list", ({ params }) =>
    Promise.resolve(
      params?.cursor === "page-2"
        ? {
            tools: [
              {
                name: "second",
                inputSchema: { type: "object" as const },
                outputSchema: {
                  type: "object" as const,
                  properties: { value: { type: "number" } },
                  required: ["value"],
                },
              },
            ],
          }
        : {
            tools: [
              {
                name: "first",
                inputSchema: { type: "object" as const },
                outputSchema: {
                  type: "object" as const,
                  properties: { value: { type: "string" } },
                  required: ["value"],
                },
              },
            ],
            nextCursor: "page-2",
          },
    ),
  )
  server.setRequestHandler("tools/call", ({ params }) =>
    Promise.resolve({
      content: [],
      structuredContent: { value: params.name === "first" ? 42 : 1 },
    }),
  )

  const client = new Client({ name: "pagination-test", version: "1.0.0" })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])

  try {
    const tools = await Effect.runPromise(McpCatalog.defs(client))
    expect(tools?.map((tool) => tool.name)).toEqual(["first", "second"])
    await expect(client.callTool({ name: "first", arguments: {} })).rejects.toThrow(/output schema/i)
  } finally {
    await Promise.all([client.close(), server.close()])
  }
})

test("accepts and validates draft-07 tool output schemas", async () => {
  const server = new Server({ name: "draft-07", version: "1.0.0" }, { capabilities: { tools: {} } })
  let calls = 0
  server.setRequestHandler("tools/list", () =>
    Promise.resolve({
      tools: [
        {
          name: "draft-07-tool",
          inputSchema: { type: "object" as const },
          outputSchema: {
            $schema: "http://json-schema.org/draft-07/schema#",
            type: "object" as const,
            properties: { value: { type: "string" } },
            required: ["value"],
          },
        },
      ],
    }),
  )
  server.setRequestHandler("tools/call", () => {
    calls++
    return Promise.resolve({ content: [], structuredContent: { value: calls === 1 ? "valid" : 42 } })
  })

  const client = new Client({ name: "draft-07-test", version: "1.0.0" }, CLIENT_OPTIONS)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)])

  try {
    const tools = await Effect.runPromise(McpCatalog.defs(client))
    expect(tools?.map((tool) => tool.name)).toEqual(["draft-07-tool"])
    await expect(client.callTool({ name: "draft-07-tool", arguments: {} })).resolves.toMatchObject({
      structuredContent: { value: "valid" },
    })
    await expect(client.callTool({ name: "draft-07-tool", arguments: {} })).rejects.toThrow(/output schema/i)
    expect(calls).toBe(2)
  } finally {
    await Promise.all([client.close(), server.close()])
  }
})
