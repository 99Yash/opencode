import { ConfigMCP } from "@opencode-ai/schema/config/mcp"
import { codeModeCompatibilityDefault, McpCodeModePlugin } from "@opencode-ai/core/plugin/mcp-codemode"
import { describe, expect, it } from "bun:test"
import { Effect } from "effect"

describe("MCP Code Mode compatibility defaults", () => {
  it("keeps Cloudflare's Code Mode MCP server direct by default", () => {
    const config = new ConfigMCP.Remote({ type: "remote", url: "https://mcp.cloudflare.com/mcp" })
    expect(codeModeCompatibilityDefault(config)).toBe(false)
  })

  it("does not change Cloudflare's product-specific MCP servers", () => {
    const config = new ConfigMCP.Remote({ type: "remote", url: "https://docs.mcp.cloudflare.com/mcp" })
    expect(codeModeCompatibilityDefault(config)).toBeUndefined()
  })

  it("does not change local or unrelated remote servers", () => {
    const local = new ConfigMCP.Local({ type: "local", command: ["server"] })
    const remote = new ConfigMCP.Remote({ type: "remote", url: "https://example.com/mcp" })
    expect(codeModeCompatibilityDefault(local)).toBeUndefined()
    expect(codeModeCompatibilityDefault(remote)).toBeUndefined()
  })

  it("retains a registered direct-tool default", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const defaults = yield* McpCodeModePlugin.Service
          yield* defaults.register(codeModeCompatibilityDefault)
          const config = new ConfigMCP.Remote({ type: "remote", url: "https://mcp.cloudflare.com/mcp" })
          expect(defaults.resolve(config)).toBe(false)
        }).pipe(Effect.provide(McpCodeModePlugin.layer)),
      ),
    )
  })
})
