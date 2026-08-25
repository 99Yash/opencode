import { BrowserTunnel } from "@opencode-ai/schema/browser-tunnel"
import { randomBytes, timingSafeEqual } from "node:crypto"
import {
  Agent,
  createServer,
  request,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from "node:http"
import type { Duplex } from "node:stream"

export async function createBrowserProxy(input: {
  readonly connect: (target: BrowserTunnel.Target, signal: AbortSignal) => Promise<Duplex>
}) {
  const credentials = { username: randomBytes(16).toString("hex"), password: randomBytes(32).toString("hex") }
  const expected = Buffer.from(
    `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString("base64")}`,
  )
  const clients = new Set<Duplex>()
  const tunnels = new Set<Duplex>()
  const lifetime = new AbortController()
  let closing: Promise<void> | undefined

  const authorized = (header: string | string[] | undefined) => {
    if (typeof header !== "string") return false
    const actual = Buffer.from(header)
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  }
  const connect = async (target: BrowserTunnel.Target, signal: AbortSignal) => {
    if (lifetime.signal.aborted) throw new Error("Browser proxy is closed")
    const abort = AbortSignal.any([signal, lifetime.signal])
    const tunnel = await input.connect(target, abort)
    if (abort.aborted) {
      tunnel.destroy()
      throw abort.reason ?? new Error("Browser proxy is closed")
    }
    tunnels.add(tunnel)
    tunnel.once("close", () => tunnels.delete(tunnel))
    tunnel.on("error", () => tunnel.destroy())
    return tunnel
  }

  const server = createServer({ maxHeaderSize: 64 * 1_024 }, (incoming, response) => {
    if (!authorized(incoming.headers["proxy-authorization"])) {
      response.writeHead(407, { "Proxy-Authenticate": 'Basic realm="OpenCode Browser Proxy"' }).end()
      return
    }
    void forward(incoming, response, connect).catch(() => response.destroy())
  })
  server.requestTimeout = 30_000
  server.headersTimeout = 10_000
  server.keepAliveTimeout = 5_000
  server.on("connection", (socket) => {
    clients.add(socket)
    socket.once("close", () => clients.delete(socket))
  })
  server.on("connect", (incoming, socket, head) => {
    void forwardConnect(incoming, socket, head, connect, authorized).catch(() => {
      if (!socket.destroyed) socket.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
    })
  })
  server.on("error", () => undefined)
  server.on("clientError", (_error, socket) => {
    if (!socket.destroyed) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n")
  })

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Browser proxy did not bind a TCP address")
  return {
    url: `http://127.0.0.1:${address.port}`,
    host: "127.0.0.1",
    port: address.port,
    credentials,
    close() {
      if (closing) return closing
      lifetime.abort(new Error("Browser proxy is closed"))
      tunnels.forEach((tunnel) => tunnel.destroy())
      clients.forEach((client) => client.destroy())
      closing = new Promise<void>((resolve) => server.close(() => resolve()))
      return closing
    },
  }
}

async function forwardConnect(
  incoming: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  connect: (target: BrowserTunnel.Target, signal: AbortSignal) => Promise<Duplex>,
  authorized: (header: string | string[] | undefined) => boolean,
) {
  if (!authorized(incoming.headers["proxy-authorization"])) {
    socket.end(
      'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="OpenCode Browser Proxy"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n',
    )
    return
  }
  const match = /^(?:\[([^\]]+)\]|([^:]+))(?::([0-9]+))?$/.exec(incoming.url ?? "")
  const host = match?.[1] ?? match?.[2]
  const port = Number(match?.[3] ?? 443)
  if (!host || host.length > 253 || /[\s/?#]/.test(host) || !Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    socket.end("HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
    return
  }
  const abort = new AbortController()
  const cancel = () => abort.abort(new Error("Browser proxy client closed"))
  socket.once("close", cancel)
  socket.pause()
  const tunnel = await connect(
    { host: BrowserTunnel.Host.make(host), port: BrowserTunnel.Port.make(port) },
    abort.signal,
  ).finally(() => socket.off("close", cancel))
  if (socket.destroyed) {
    tunnel.destroy()
    return
  }
  socket.write("HTTP/1.1 200 Connection Established\r\n\r\n")
  if (head.byteLength) tunnel.write(head)
  socket.on("error", () => tunnel.destroy())
  tunnel.on("error", () => socket.destroy())
  socket.once("close", () => tunnel.destroy())
  tunnel.once("close", () => socket.destroy())
  socket.pipe(tunnel).pipe(socket)
  socket.resume()
}

async function forward(
  incoming: IncomingMessage,
  response: ServerResponse,
  connect: (target: BrowserTunnel.Target, signal: AbortSignal) => Promise<Duplex>,
) {
  if (!incoming.url || !URL.canParse(incoming.url)) {
    response.writeHead(400).end()
    return
  }
  const url = new URL(incoming.url)
  if (url.protocol !== "http:" || url.username || url.password) {
    response.writeHead(400).end()
    return
  }
  const abort = new AbortController()
  const cancel = () => abort.abort(new Error("Browser proxy client closed"))
  incoming.once("aborted", cancel)
  response.once("close", cancel)
  const host = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname
  const port = url.port ? Number(url.port) : 80
  const tunnel = await connect(
    { host: BrowserTunnel.Host.make(host), port: BrowserTunnel.Port.make(port) },
    abort.signal,
  )
  const headers = forwardedHeaders(incoming.headers)
  headers.host = url.host
  headers.connection = "close"
  const agent = new Agent({ keepAlive: false, maxSockets: 1 })
  agent.createConnection = () => tunnel
  await new Promise<void>((resolve, reject) => {
    const upstream = request(
      {
        agent,
        hostname: url.hostname,
        port,
        path: `${url.pathname}${url.search}`,
        method: incoming.method,
        headers,
        signal: abort.signal,
      },
      (result) => {
        const headers = forwardedHeaders(result.headers)
        headers.connection = "close"
        response.writeHead(result.statusCode ?? 502, result.statusMessage, headers)
        result.once("error", reject)
        response.once("finish", resolve)
        result.pipe(response)
      },
    )
    upstream.once("error", reject)
    incoming.pipe(upstream)
  }).finally(() => {
    incoming.off("aborted", cancel)
    response.off("close", cancel)
    agent.destroy()
    tunnel.destroy()
  })
}

function forwardedHeaders(input: IncomingHttpHeaders) {
  const headers = { ...input }
  if (typeof headers.connection === "string") {
    headers.connection.split(",").forEach((name) => delete headers[name.trim().toLowerCase()])
  }
  ;[
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "proxy-connection",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
  ].forEach((name) => delete headers[name])
  return headers
}
