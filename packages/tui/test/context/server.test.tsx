/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { describe, expect, test } from "bun:test"
import { ServerProvider, decodeServerURLs, normalizeServerURL, serverName, useServer } from "../../src/context/server"

describe("TUI servers", () => {
  test("normalizes equivalent endpoint URLs", () => {
    expect(normalizeServerURL(" https://devbox.example/ ")).toBe("https://devbox.example")
    expect(normalizeServerURL("http://localhost:4096///")).toBe("http://localhost:4096")
    expect(normalizeServerURL("devbox.example:4096")).toBe("http://devbox.example:4096")
    expect(() => normalizeServerURL("https://user:secret@devbox.example")).toThrow("must not contain credentials")
    expect(() => normalizeServerURL("https://devbox.example?token=secret")).toThrow("query or fragment")
  })

  test("labels loopback and remote servers", () => {
    expect(serverName("http://127.0.0.1:49374")).toBe("Local")
    expect(serverName("https://devbox.example:4096")).toBe("devbox.example:4096")
  })

  test("decodes only valid persisted URLs", () => {
    expect(decodeServerURLs({ servers: ["https://devbox.example", 1, "ftp://nope"] })).toEqual([
      "https://devbox.example",
    ])
    expect(decodeServerURLs(null)).toEqual([])
  })
})

test("switches only after the next server is prepared", async () => {
  let server!: ReturnType<typeof useServer>
  const steps: string[] = []

  function Harness() {
    server = useServer()
    return <box />
  }

  const app = await testRender(() => (
    <ServerProvider
      initial={{ endpoint: { url: "http://localhost:4096" } }}
      urls={["https://devbox.example", "http://localhost:4096/"]}
      connect={async (url) => {
        steps.push(`connect:${url}`)
        return { url }
      }}
      prepare={async (endpoint) => {
        steps.push(`prepare:${endpoint.url}`)
      }}
      save={async () => {}}
    >
      <Harness />
    </ServerProvider>
  ))
  try {
    expect(server.list().map((item) => item.url)).toEqual(["http://localhost:4096", "https://devbox.example"])
    await server.select("https://devbox.example")
    expect(steps).toEqual(["connect:https://devbox.example", "prepare:https://devbox.example"])
    expect(server.current.url).toBe("https://devbox.example")
  } finally {
    app.renderer.destroy()
  }
})

test("persists only the normalized URL after a successful add", async () => {
  let server!: ReturnType<typeof useServer>
  const writes: string[][] = []

  function Harness() {
    server = useServer()
    return <box />
  }

  const app = await testRender(() => (
    <ServerProvider
      initial={{ endpoint: { url: "http://localhost:4096" } }}
      urls={[]}
      connect={async (url) => ({
        url,
        auth: { type: "basic", username: "opencode", password: "secret" },
      })}
      prepare={async () => {}}
      save={async (urls) => void writes.push(urls)}
    >
      <Harness />
    </ServerProvider>
  ))
  try {
    await server.add("devbox.example:4096/")
    expect(writes).toEqual([["http://devbox.example:4096"]])
    expect(JSON.stringify(writes)).not.toContain("secret")
    expect(server.current.endpoint.auth?.password).toBe("secret")
  } finally {
    app.renderer.destroy()
  }
})

test("keeps the current server when preparing a new endpoint fails", async () => {
  let server!: ReturnType<typeof useServer>
  let saved = false

  function Harness() {
    server = useServer()
    return <box />
  }

  const app = await testRender(() => (
    <ServerProvider
      initial={{ endpoint: { url: "http://localhost:4096" } }}
      urls={[]}
      connect={async (url) => ({ url })}
      prepare={async () => {
        throw new Error("unreachable")
      }}
      save={async () => {
        saved = true
      }}
    >
      <Harness />
    </ServerProvider>
  ))
  try {
    await expect(server.add("https://devbox.example")).rejects.toThrow("unreachable")
    expect(server.current.url).toBe("http://localhost:4096")
    expect(saved).toBeFalse()
  } finally {
    app.renderer.destroy()
  }
})
