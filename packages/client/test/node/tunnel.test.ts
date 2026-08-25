import { BrowserTunnelProtocol } from "@opencode-ai/protocol/browser-tunnel"
import { Browser } from "@opencode-ai/schema/browser"
import { BrowserTunnel } from "@opencode-ai/schema/browser-tunnel"
import { Session } from "@opencode-ai/schema/session"
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { once } from "node:events"
import { createServer } from "node:http"
import { connect } from "node:net"
import WebSocket, { WebSocketServer } from "ws"
import { createBrowserProxy } from "../../src/node/browser/proxy.js"
import { openBrowserTunnel } from "../../src/node/browser/tunnel.js"

describe("browser tunnel", () => {
  test("uses the Protocol tunnel path and exchanges isolated binary TCP frames", async () => {
    const authorization = "Bearer tunnel-secret"
    const server = await tunnelServer(authorization)
    try {
      const sessionID = Session.ID.make("ses_tunnel_browser")
      const leaseID = Browser.LeaseID.create()
      const target = { host: BrowserTunnel.Host.make("example.com"), port: BrowserTunnel.Port.make(443) }
      const opening = openBrowserTunnel({
        endpoint: { url: `${server.url}/discarded?query=true#fragment`, authorization },
        sessionID,
        leaseID,
        target,
      })
      const socket = await server.connected
      const handshake = await server.next()
      expect(handshake.binary).toBe(false)
      expect(await Effect.runPromise(BrowserTunnelProtocol.decodeFromClient(handshake.data))).toEqual({
        type: "browser.tunnel.open",
        sessionID,
        leaseID,
        target,
      })
      expect(server.path()).toBe(BrowserTunnelProtocol.Path)
      expect(server.authorization()).toBe(authorization)
      socket.send(BrowserTunnelProtocol.encodeFromServer({ type: "browser.tunnel.opened" }))
      const stream = await opening

      const incoming = once(stream, "data")
      socket.send(Buffer.from("server bytes"), { binary: true })
      expect(Buffer.from((await incoming)[0]).toString()).toBe("server bytes")

      const payload = Buffer.alloc(BrowserTunnelProtocol.MaxFrameBytes + 3, 7)
      await new Promise<void>((resolve, reject) =>
        stream.write(payload, (error) => (error ? reject(error) : resolve())),
      )
      const first = await server.next()
      const second = await server.next()
      expect(first.binary).toBe(true)
      expect(second.binary).toBe(true)
      expect(first.data.byteLength).toBe(BrowserTunnelProtocol.MaxFrameBytes)
      expect(second.data.byteLength).toBe(3)
      expect(Buffer.concat([first.data, second.data])).toEqual(payload)

      stream.destroy()
    } finally {
      await server.close()
    }
  })

  test("preserves typed tunnel rejection errors", async () => {
    const server = await tunnelServer()
    try {
      const opening = openBrowserTunnel({
        endpoint: { url: server.url },
        sessionID: Session.ID.make("ses_rejected_tunnel"),
        leaseID: Browser.LeaseID.create(),
        target: { host: BrowserTunnel.Host.make("example.com"), port: BrowserTunnel.Port.make(443) },
      })
      const socket = await server.connected
      await server.next()
      socket.send(
        BrowserTunnelProtocol.encodeFromServer({
          type: "browser.tunnel.rejected",
          code: "stale_lease",
          message: "The browser lease expired.",
        }),
      )
      await expect(opening).rejects.toMatchObject({ code: "stale_lease", message: "The browser lease expired." })
    } finally {
      await server.close()
    }
  })
})

describe("browser loopback proxy", () => {
  test("authenticates HTTP requests and forwards them without leaking proxy credentials", async () => {
    let authorization: string | undefined
    const upstream = createServer((incoming, response) => {
      authorization = incoming.headers["proxy-authorization"]
      const body = `${incoming.method} ${incoming.url}`
      response.writeHead(200, { "content-type": "text/plain", "content-length": Buffer.byteLength(body) }).end(body)
    })
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve))
    const address = upstream.address()
    if (!address || typeof address === "string") throw new Error("upstream server did not bind")
    const proxy = await createBrowserProxy({
      connect: async (target, signal) => {
        const socket = connect({ host: target.host, port: target.port })
        await once(socket, "connect", { signal })
        return socket
      },
    })
    try {
      expect(proxy.host).toBe("127.0.0.1")
      const target = `http://127.0.0.1:${address.port}/browser?ready=true`
      expect((await proxyRequest(proxy.port, target)).status).toBe(407)
      const header = `Basic ${Buffer.from(`${proxy.credentials.username}:${proxy.credentials.password}`).toString("base64")}`
      expect(await proxyRequest(proxy.port, target, header)).toEqual({ status: 200, body: "GET /browser?ready=true" })
      expect(authorization).toBeUndefined()

      const socket = connect({ host: proxy.host, port: proxy.port })
      await once(socket, "connect")
      socket.write(
        `CONNECT 127.0.0.1:${address.port} HTTP/1.1\r\nHost: 127.0.0.1:${address.port}\r\nProxy-Authorization: ${header}\r\n\r\n`,
      )
      const [connected] = await once(socket, "data")
      expect(Buffer.from(connected).toString()).toContain("200 Connection Established")
      socket.write(`GET /through-connect HTTP/1.1\r\nHost: 127.0.0.1:${address.port}\r\nConnection: close\r\n\r\n`)
      const chunks: Buffer[] = []
      for await (const chunk of socket) chunks.push(Buffer.from(chunk))
      expect(Buffer.concat(chunks).toString()).toContain("GET /through-connect")
    } finally {
      await proxy.close()
      upstream.closeAllConnections()
      await new Promise<void>((resolve) => upstream.close(() => resolve()))
    }
  })
})

async function tunnelServer(authorization?: string) {
  const http = createServer()
  const webSockets = new WebSocketServer({ noServer: true })
  const queued: Array<{ data: Buffer; binary: boolean }> = []
  const waiting: Array<(message: { data: Buffer; binary: boolean }) => void> = []
  const connected = Promise.withResolvers<WebSocket>()
  let path: string | undefined
  let header: string | undefined
  webSockets.once("connection", (socket) => {
    socket.on("message", (data, binary) => {
      const payload = data instanceof ArrayBuffer ? Buffer.from(data) : Array.isArray(data) ? Buffer.concat(data) : data
      const message = { data: payload, binary }
      const resolve = waiting.shift()
      if (resolve) {
        resolve(message)
        return
      }
      queued.push(message)
    })
    connected.resolve(socket)
  })
  http.on("upgrade", (incoming, socket, head) => {
    path = incoming.url
    header = incoming.headers.authorization
    if (
      path !== BrowserTunnelProtocol.Path ||
      header !== authorization ||
      incoming.headers["sec-websocket-protocol"] !== BrowserTunnelProtocol.Subprotocol
    ) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n")
      return
    }
    webSockets.handleUpgrade(incoming, socket, head, (connection) =>
      webSockets.emit("connection", connection, incoming),
    )
  })
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve))
  const address = http.address()
  if (!address || typeof address === "string") throw new Error("tunnel server did not bind")
  return {
    connected: connected.promise,
    url: `http://127.0.0.1:${address.port}`,
    path: () => path,
    authorization: () => header,
    next: async () =>
      queued.shift() ?? new Promise<{ data: Buffer; binary: boolean }>((resolve) => waiting.push(resolve)),
    async close() {
      webSockets.clients.forEach((socket) => socket.terminate())
      webSockets.close()
      http.closeAllConnections()
      await new Promise<void>((resolve) => http.close(() => resolve()))
    },
  }
}

async function proxyRequest(port: number, path: string, authorization?: string) {
  const socket = connect({ host: "127.0.0.1", port })
  await once(socket, "connect")
  socket.write(
    `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n${authorization ? `Proxy-Authorization: ${authorization}\r\n` : ""}Connection: close\r\n\r\n`,
  )
  const chunks: Buffer[] = []
  for await (const chunk of socket) chunks.push(Buffer.from(chunk))
  const response = Buffer.concat(chunks).toString()
  const separator = response.indexOf("\r\n\r\n")
  return { status: Number(response.split(" ", 3)[1]), body: response.slice(separator + 4) }
}
