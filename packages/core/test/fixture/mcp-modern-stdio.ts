import { inputRequired, Server } from "@modelcontextprotocol/server"
import { serveStdio } from "@modelcontextprotocol/server/stdio"

serveStdio(() => {
  let changed = false
  const server = new Server(
    { name: "modern-stdio", version: "1.0.0" },
    { capabilities: { tools: { listChanged: true } }, instructions: "Modern stdio instructions" },
  )
  server.setRequestHandler("tools/list", async () => ({
    tools: [
      {
        name: changed ? "updated" : "initial",
        // Header annotations are HTTP-only and must not affect our custom stdio transport.
        inputSchema: { type: "object", properties: { value: { type: "string", "x-mcp-header": "not a header" } } },
      },
    ],
  }))
  server.setRequestHandler("tools/call", async (_request, ctx) => {
    if (!ctx.mcpReq.inputResponses) return inputRequired({ inputRequests: { roots: inputRequired.listRoots() } })
    changed = true
    await server.sendToolListChanged()
    return { content: [], structuredContent: ctx.mcpReq.inputResponses }
  })
  return server
})
