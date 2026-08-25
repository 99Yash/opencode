import { BrowserControlProtocol } from "@opencode-ai/protocol/browser-control"
import { BrowserControl } from "@opencode-ai/schema/browser-control"
import { Browser, BrowserDriver, OpenCode, type BrowserDriverInstance } from "@opencode-ai/client/node"
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { once } from "node:events"
import { createServer } from "node:http"
import WebSocket, { WebSocketServer } from "ws"

const state: Browser.State = {
  url: "https://example.com/",
  title: "Example",
  loading: false,
  canGoBack: false,
  canGoForward: false,
  generation: 1,
}

describe("Node browser client", () => {
  test("registers a Session and handles open, attach, commands, detach, and reattachment", async () => {
    const server = await controlServer()
    let opened = 0
    let disposed = 0
    try {
      const registering = OpenCode.make({ baseUrl: server.url }).browser.register({
        sessionID: "ses_node_browser",
        open: () => {
          opened++
        },
      })
      const socket = await server.connected
      const next = reader(socket)
      expect(await next()).toEqual({ type: "browser.control.register", sessionID: "ses_node_browser" })
      socket.send(BrowserControlProtocol.encodeFromServer({ type: "browser.control.registered" }))
      const registration = await registering

      socket.send(BrowserControlProtocol.encodeFromServer({ type: "browser.control.open" }))
      await waitFor(() => opened === 1)

      const driver = BrowserDriver.define(({ proxy }) => ({
        resource: proxy,
        state: () => state,
        subscribe: () => () => undefined,
        execute: async () => ({ type: "snapshot", state, format: "opencode.semantic.v1", content: "snapshot" }),
        dispose: () => {
          disposed++
        },
      }))
      const attaching = registration.attach({ driver })
      const attach = await next()
      if (attach.type !== "browser.control.attach") throw new Error("expected browser attach")
      expect(attach.state).toEqual(state)
      socket.send(
        BrowserControlProtocol.encodeFromServer({ type: "browser.control.attached", leaseID: attach.leaseID }),
      )
      const attachment = await attaching
      expect(attachment.resource.url).toStartWith("http://127.0.0.1:")
      expect(attachment.resource.credentials.username).not.toBe(attachment.resource.credentials.password)
      expect((await next()).type).toBe("browser.control.state")

      const requestID = BrowserControl.RequestID.create()
      socket.send(
        BrowserControlProtocol.encodeFromServer({
          type: "browser.control.request",
          requestID,
          leaseID: attach.leaseID,
          command: { type: "snapshot", generation: 1 },
        }),
      )
      expect(await next()).toMatchObject({
        type: "browser.control.response",
        requestID,
        leaseID: attach.leaseID,
        outcome: { type: "success", result: { type: "snapshot", content: "snapshot" } },
      })

      await attachment.close()
      expect(await next()).toEqual({ type: "browser.control.detach", leaseID: attach.leaseID })
      expect(socket.readyState).toBe(WebSocket.OPEN)
      expect(disposed).toBe(1)

      const reattaching = registration.attach({ driver })
      const reattach = await next()
      if (reattach.type !== "browser.control.attach") throw new Error("expected browser reattach")
      expect(reattach.leaseID).not.toBe(attach.leaseID)
      socket.send(
        BrowserControlProtocol.encodeFromServer({ type: "browser.control.attached", leaseID: reattach.leaseID }),
      )
      const reattached = await reattaching
      expect((await next()).type).toBe("browser.control.state")
      await reattached.close()
      expect(await next()).toEqual({ type: "browser.control.detach", leaseID: reattach.leaseID })
      expect(disposed).toBe(2)

      const closed = once(socket, "close")
      await registration.close()
      await closed
    } finally {
      await server.close()
    }
  })

  test("cancels an unacknowledged attachment without closing its registration", async () => {
    const server = await controlServer()
    let disposed = 0
    try {
      const registering = OpenCode.make({ baseUrl: server.url }).browser.register({
        sessionID: "ses_cancelled_browser",
        open: () => undefined,
      })
      const socket = await server.connected
      const next = reader(socket)
      await next()
      socket.send(BrowserControlProtocol.encodeFromServer({ type: "browser.control.registered" }))
      const registration = await registering
      const driver = BrowserDriver.define(() => ({
        resource: "browser",
        state: () => state,
        subscribe: () => () => undefined,
        execute: async () => ({ type: "snapshot", state, format: "opencode.semantic.v1", content: "snapshot" }),
        dispose: () => {
          disposed++
        },
      }))

      const abort = new AbortController()
      const attaching = registration.attach({ driver, signal: abort.signal })
      const cancelled = await next()
      if (cancelled.type !== "browser.control.attach") throw new Error("expected browser attach")
      abort.abort(new Error("Browser attachment was aborted"))
      await expect(attaching).rejects.toThrow("aborted")
      expect(await next()).toEqual({ type: "browser.control.detach", leaseID: cancelled.leaseID })
      expect(disposed).toBe(1)

      const reattaching = registration.attach({ driver })
      const attach = await next()
      if (attach.type !== "browser.control.attach") throw new Error("expected browser reattach")
      socket.send(
        BrowserControlProtocol.encodeFromServer({ type: "browser.control.attached", leaseID: cancelled.leaseID }),
      )
      socket.send(
        BrowserControlProtocol.encodeFromServer({ type: "browser.control.attached", leaseID: attach.leaseID }),
      )
      const attachment = await reattaching
      expect((await next()).type).toBe("browser.control.state")
      expect(socket.readyState).toBe(WebSocket.OPEN)
      await attachment.close()
      expect(await next()).toEqual({ type: "browser.control.detach", leaseID: attach.leaseID })
      expect(disposed).toBe(2)
      await registration.close()
    } finally {
      await server.close()
    }
  })

  test("uses the Protocol control path and forwards the configured authorization header", async () => {
    const authorization = "Bearer browser-secret"
    const server = await controlServer(authorization)
    try {
      const registering = OpenCode.make({
        baseUrl: `${server.url}/discarded?query=true#fragment`,
        headers: { Authorization: authorization },
      }).browser.register({ sessionID: "ses_authorized_browser", open: () => undefined })
      const socket = await server.connected
      const next = reader(socket)
      expect(await next()).toEqual({ type: "browser.control.register", sessionID: "ses_authorized_browser" })
      expect(server.path()).toBe(BrowserControlProtocol.Path)
      expect(server.authorization()).toBe(authorization)
      socket.send(BrowserControlProtocol.encodeFromServer({ type: "browser.control.registered" }))
      await (await registering).close()
    } finally {
      await server.close()
    }
  })

  test("rejects a browser registration when the authorization header is invalid", async () => {
    const server = await controlServer("Bearer required")
    try {
      await expect(
        OpenCode.make({ baseUrl: server.url }).browser.register({
          sessionID: "ses_rejected_browser",
          open: () => undefined,
        }),
      ).rejects.toThrow()
    } finally {
      await server.close()
    }
  })

  test("rejects invalid Session IDs before connecting", async () => {
    await expect(
      OpenCode.make({ baseUrl: "http://127.0.0.1:1" }).browser.register({ sessionID: "wrong", open: () => undefined }),
    ).rejects.toThrow("valid Session ID")
  })

  test("cleans up a driver that finishes attaching after its registration closes", async () => {
    const server = await controlServer()
    const started = Promise.withResolvers<void>()
    const driver = Promise.withResolvers<BrowserDriverInstance<{ readonly name: string }>>()
    let disposed = 0
    try {
      const registering = OpenCode.make({ baseUrl: server.url }).browser.register({
        sessionID: "ses_closing_browser",
        open: () => undefined,
      })
      const socket = await server.connected
      const next = reader(socket)
      await next()
      socket.send(BrowserControlProtocol.encodeFromServer({ type: "browser.control.registered" }))
      const registration = await registering
      const attaching = registration.attach({
        driver: BrowserDriver.define(async () => {
          started.resolve()
          return driver.promise
        }),
      })
      await started.promise
      await registration.close()
      driver.resolve({
        resource: { name: "late browser" },
        state: () => state,
        subscribe: () => () => undefined,
        execute: async () => ({ type: "snapshot", state, format: "opencode.semantic.v1", content: "snapshot" }),
        dispose: () => {
          disposed++
        },
      })
      await expect(attaching).rejects.toThrow("closed")
      expect(disposed).toBe(1)
    } finally {
      await server.close()
    }
  })

  test("rejects commands for another browser lease without invoking the attached driver", async () => {
    const server = await controlServer()
    let executed = 0
    try {
      const registering = OpenCode.make({ baseUrl: server.url }).browser.register({
        sessionID: "ses_isolated_browser",
        open: () => undefined,
      })
      const socket = await server.connected
      const next = reader(socket)
      await next()
      socket.send(BrowserControlProtocol.encodeFromServer({ type: "browser.control.registered" }))
      const registration = await registering
      const attaching = registration.attach({
        driver: BrowserDriver.define(() => ({
          resource: undefined,
          state: () => state,
          subscribe: () => () => undefined,
          execute: async () => {
            executed++
            return { type: "snapshot", state, format: "opencode.semantic.v1", content: "snapshot" }
          },
          dispose: () => undefined,
        })),
      })
      const attach = await next()
      if (attach.type !== "browser.control.attach") throw new Error("expected browser attach")
      socket.send(
        BrowserControlProtocol.encodeFromServer({ type: "browser.control.attached", leaseID: attach.leaseID }),
      )
      await attaching
      await next()

      const requestID = BrowserControl.RequestID.create()
      const leaseID = Browser.LeaseID.create()
      socket.send(
        BrowserControlProtocol.encodeFromServer({
          type: "browser.control.request",
          requestID,
          leaseID,
          command: { type: "snapshot", generation: 1 },
        }),
      )
      expect(await next()).toMatchObject({
        type: "browser.control.response",
        requestID,
        leaseID,
        outcome: { type: "failure", code: "not_attached" },
      })
      expect(executed).toBe(0)
      await registration.close()
    } finally {
      await server.close()
    }
  })
})

async function controlServer(authorization?: string) {
  const http = createServer()
  const webSockets = new WebSocketServer({ noServer: true })
  const connected = Promise.withResolvers<WebSocket>()
  let path: string | undefined
  let header: string | undefined
  webSockets.once("connection", connected.resolve)
  http.on("upgrade", (request, socket, head) => {
    path = request.url
    header = request.headers.authorization
    if (
      path !== BrowserControlProtocol.Path ||
      header !== authorization ||
      request.headers["sec-websocket-protocol"] !== BrowserControlProtocol.Subprotocol
    ) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n")
      return
    }
    webSockets.handleUpgrade(request, socket, head, (connection) => webSockets.emit("connection", connection, request))
  })
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve))
  const address = http.address()
  if (!address || typeof address === "string") throw new Error("control server did not bind")
  return {
    connected: connected.promise,
    url: `http://127.0.0.1:${address.port}`,
    path: () => path,
    authorization: () => header,
    async close() {
      webSockets.clients.forEach((socket) => socket.terminate())
      webSockets.close()
      http.closeAllConnections()
      await new Promise<void>((resolve) => http.close(() => resolve()))
    },
  }
}

function reader(socket: WebSocket) {
  const queued: WebSocket.RawData[] = []
  const waiting: Array<(data: WebSocket.RawData) => void> = []
  socket.on("message", (data, binary) => {
    if (binary) throw new Error("expected text control message")
    const resolve = waiting.shift()
    if (resolve) {
      resolve(data)
      return
    }
    queued.push(data)
  })
  return async () => {
    const data = queued.shift() ?? (await new Promise<WebSocket.RawData>((resolve) => waiting.push(resolve)))
    const payload =
      data instanceof ArrayBuffer ? new Uint8Array(data) : Array.isArray(data) ? Buffer.concat(data) : data
    return Effect.runPromise(BrowserControlProtocol.decodeFromClient(payload))
  }
}

async function waitFor(check: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return
    await Bun.sleep(5)
  }
  throw new Error("timed out waiting for browser client")
}
