import { appendFileSync } from "node:fs"
import { createInterface } from "node:readline"
import { JSONRPCMessageSchema } from "@modelcontextprotocol/core"

const mode = process.env.MCP_DISCOVERY_MODE
const log = process.env.MCP_DISCOVERY_LOG
const record = (event: string) => {
  if (log) appendFileSync(log, `${process.pid} ${event}\n`)
}
record("start")
process.on("exit", () => record("exit"))
process.on("SIGTERM", () => process.exit(0))
process.stdin.on("end", () => {
  if (mode === "unsupported-slow-close") return
  process.exit(0)
})

if (mode === "unsupported-slow-close") setInterval(() => {}, 1_000)

if (mode === "slow-modern") await Bun.sleep(1_200)

let discoveries = 0
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSONRPCMessageSchema.parse(JSON.parse(line))
  if (!("method" in message)) {
    record("response")
    continue
  }
  record(message.method)
  if (!("id" in message)) continue
  const reply = (result: object) =>
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\n")
  const reject = (code: number, data?: object) =>
    process.stdout.write(
      JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code, message: "Fixture rejection", data } }) + "\n",
    )

  if (message.method === "server/discover") {
    discoveries += 1
    if (mode === "exit") process.exit(1)
    if (mode === "silent") continue
    if (mode === "legacy") {
      reject(-32601)
      continue
    }
    if (mode === "malformed") {
      reply({ supportedVersions: "not an array" })
      continue
    }
    if (
      mode === "unsupported" ||
      mode === "unsupported-slow-close" ||
      mode === "corrective-loop" ||
      (mode === "corrective" && discoveries === 1)
    ) {
      reject(-32022, {
        supported: [mode.startsWith("unsupported") ? "2027-01-01" : "2026-07-28"],
        requested: "2026-07-28",
      })
      continue
    }
    // Discovery must not answer unsolicited server requests on this disposable pipe.
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: "server-request", method: "roots/list" }) + "\n")
    reply({
      resultType: "complete",
      ttlMs: 0,
      cacheScope: "private",
      supportedVersions: ["2026-07-28"],
      capabilities: { tools: {} },
      instructions: JSON.stringify({
        cwd: process.cwd(),
        configured: process.env.MCP_DISCOVERY_CONFIG,
        meta: message.params?._meta,
      }),
      _meta: { "io.modelcontextprotocol/serverInfo": { name: "discovery-fixture", version: "1.0.0" } },
    })
    continue
  }
  if (message.method === "initialize") {
    if (mode === "slow-modern") {
      reject(-32601)
      continue
    }
    reply({
      protocolVersion: "2025-11-25",
      capabilities: { tools: {} },
      serverInfo: { name: "legacy-fixture", version: "1.0.0" },
    })
    continue
  }
  if (message.method === "tools/list") {
    reply({
      resultType: "complete",
      ttlMs: 0,
      cacheScope: "private",
      tools: [{ name: "fixture", inputSchema: { type: "object" } }],
    })
    continue
  }
  reject(-32601)
}
