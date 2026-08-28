import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"

export function sessionServer() {
  const server = new Server({ name: "session", version: "1.0.0" }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, () =>
    Promise.resolve({
      tools: [{ name: "echo", inputSchema: { type: "object", properties: { text: { type: "string" } } } }],
    }),
  )
  server.setRequestHandler(CallToolRequestSchema, (request) =>
    Promise.resolve({ content: [], structuredContent: request.params }),
  )
  return server
}

if (import.meta.main) await sessionServer().connect(new StdioServerTransport())
