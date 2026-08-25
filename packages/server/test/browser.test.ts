import { BrowserHost } from "@opencode-ai/core/browser-host"
import { BrowserControlProtocol } from "@opencode-ai/protocol/browser-control"
import { BrowserTunnelProtocol } from "@opencode-ai/protocol/browser-tunnel"
import { ClientApi } from "@opencode-ai/protocol/client"
import { Browser } from "@opencode-ai/schema/browser"
import { BrowserTunnel } from "@opencode-ai/schema/browser-tunnel"
import { Session } from "@opencode-ai/schema/session"
import { expect, test } from "bun:test"
import { Effect, Fiber, Queue } from "effect"
import { Socket } from "effect/unstable/socket"
import { createServer } from "node:net"
import { it } from "../../core/test/lib/effect"
import { Api } from "../src/api"
import { BrowserControlConnection } from "../src/browser-control-connection"
import { BrowserTunnelServer } from "../src/browser-tunnel"
import { ServerFetch } from "../src/fetch"

const sessionID = Session.ID.make("ses_browser_server")
const leaseID = Browser.LeaseID.make("brl_browserserver")
const state: Browser.State = {
  url: "http://localhost/",
  title: "Local",
  loading: false,
  canGoBack: false,
  canGoForward: false,
  generation: 1,
}
const end = Symbol("end")

test("browser transport paths are explicitly experimental and share the client API group", () => {
  expect(BrowserControlProtocol.Path).toBe("/api/experimental/browser/control")
  expect(BrowserTunnelProtocol.Path).toBe("/api/experimental/browser/tunnel")
  expect(Api.groups["server.browser"].identifier).toBe(ClientApi.groups["server.browser"].identifier)
  expect(Api.groups["server.browser"].endpoints["browser.control.connect"].path).toBe(
    "/api/experimental/browser/control",
  )
  expect(Api.groups["server.browser"].endpoints["browser.tunnel.connect"].path).toBe("/api/experimental/browser/tunnel")
})

it.live("browser upgrades reject query credentials, foreign origins, unsupported protocols, and legacy paths", () =>
  Effect.gen(function* () {
    const handler = yield* ServerFetch.make({
      app: { version: "test-version" },
      database: { path: ":memory:" },
      fs: { filewatcher: false },
      password: "secret",
    })
    const authorization = `Basic ${btoa("opencode:secret")}`
    const request = (path: string, headers: Record<string, string> = {}) =>
      Effect.promise(() => handler(new Request(`http://opencode.local${path}`, { headers })))

    for (const [path, protocol] of [
      ["/api/experimental/browser/control", "opencode.browser.control.v1"],
      ["/api/experimental/browser/tunnel", "opencode.browser.tunnel.v1"],
    ] as const) {
      expect((yield* request(path)).status).toBe(401)
      expect(
        (yield* request(`${path}?auth_token=${encodeURIComponent(btoa("opencode:secret"))}`, {
          "sec-websocket-protocol": protocol,
        })).status,
      ).toBe(401)
      expect((yield* request(path, { authorization, origin: "https://attacker.invalid" })).status).toBe(403)

      const unsupported = yield* request(path, { authorization })
      expect(unsupported.status).toBe(426)
      expect(unsupported.headers.get("sec-websocket-protocol")).toBe(protocol)
    }

    expect((yield* request("/api/browser/control", { authorization })).status).toBe(404)
    expect((yield* request("/api/browser/tunnel", { authorization })).status).toBe(404)

    const document: unknown = yield* Effect.promise(() =>
      handler(new Request("http://opencode.local/openapi.json", { headers: { authorization } })).then((response) =>
        response.json(),
      ),
    )
    if (typeof document !== "object" || document === null || !("paths" in document)) {
      throw new Error("Expected an OpenAPI document")
    }
    expect(document.paths).not.toHaveProperty("/api/experimental/browser/control")
    expect(document.paths).not.toHaveProperty("/api/experimental/browser/tunnel")
  }).pipe(Effect.scoped),
)

it.live("registers and attaches with the real host before dialing server-side TCP", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const browser = yield* BrowserHost.make(() => Effect.succeed(true))
      const control = yield* attach(browser, sessionID, leaseID)
      const target = yield* echoServer
      const address = target.address()
      if (!address || typeof address === "string") throw new Error("echo server did not bind")

      const tunnels = yield* BrowserTunnelServer.make().pipe(Effect.provideService(BrowserHost.Service, browser))
      const connection = yield* tunnels.acquire
      const transport = yield* makeSocket
      const running = yield* connection.run(transport.socket).pipe(Effect.forkChild)
      yield* Queue.offer(
        transport.inbound,
        BrowserTunnelProtocol.encodeFromClient({
          type: "browser.tunnel.open",
          sessionID,
          leaseID,
          target: { host: BrowserTunnel.Host.make("127.0.0.1"), port: BrowserTunnel.Port.make(address.port) },
        }),
      )
      expect(yield* tunnelMessage(transport)).toEqual({ type: "browser.tunnel.opened" })

      yield* Queue.offer(transport.inbound, Buffer.from("through server"))
      const echoed = yield* Queue.take(transport.outbound)
      if (!(echoed instanceof Uint8Array)) throw new Error("expected raw tunnel bytes")
      expect(Buffer.from(echoed).toString()).toBe("through server")

      yield* Queue.offer(transport.inbound, end)
      yield* Fiber.join(running)
      yield* Queue.offer(control.inbound, end)
      yield* Fiber.join(control.fiber)
    }),
  ),
)

it.live("rejects browser leases belonging to a different attached Session", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const browser = yield* BrowserHost.make(() => Effect.succeed(true))
      const otherSessionID = Session.ID.make("ses_browser_other")
      const otherLeaseID = Browser.LeaseID.make("brl_browserother")
      const first = yield* attach(browser, sessionID, leaseID)
      const second = yield* attach(browser, otherSessionID, otherLeaseID)
      const tunnels = yield* BrowserTunnelServer.make().pipe(Effect.provideService(BrowserHost.Service, browser))
      const connection = yield* tunnels.acquire
      const transport = yield* makeSocket
      const running = yield* connection.run(transport.socket).pipe(Effect.forkChild)

      yield* Queue.offer(
        transport.inbound,
        BrowserTunnelProtocol.encodeFromClient({
          type: "browser.tunnel.open",
          sessionID,
          leaseID: otherLeaseID,
          target: { host: BrowserTunnel.Host.make("127.0.0.1"), port: BrowserTunnel.Port.make(1) },
        }),
      )
      expect(yield* tunnelMessage(transport)).toMatchObject({ type: "browser.tunnel.rejected", code: "stale_lease" })
      yield* Fiber.join(running)

      yield* Queue.offer(first.inbound, end)
      yield* Queue.offer(second.inbound, end)
      yield* Queue.offer(transport.inbound, end)
      yield* Fiber.join(first.fiber)
      yield* Fiber.join(second.fiber)
    }),
  ),
)

function attach(browser: BrowserHost.Interface, id: Session.ID, lease: Browser.LeaseID) {
  return Effect.gen(function* () {
    const control = yield* makeSocket
    const fiber = yield* BrowserControlConnection.run(browser, control.socket).pipe(Effect.forkChild)
    yield* Queue.offer(
      control.inbound,
      BrowserControlProtocol.encodeFromClient({ type: "browser.control.register", sessionID: id }),
    )
    expect(yield* controlMessage(control)).toEqual({ type: "browser.control.registered" })
    yield* Queue.offer(
      control.inbound,
      BrowserControlProtocol.encodeFromClient({ type: "browser.control.attach", leaseID: lease, state }),
    )
    expect(yield* controlMessage(control)).toEqual({ type: "browser.control.attached", leaseID: lease })
    return { ...control, fiber }
  })
}

const makeSocket = Effect.gen(function* () {
  const inbound = yield* Queue.unbounded<string | Uint8Array | typeof end>()
  const outbound = yield* Queue.unbounded<string | Uint8Array | Socket.CloseEvent>()
  return {
    inbound,
    outbound,
    socket: Socket.make({
      runRaw: (handler, options) =>
        Effect.gen(function* () {
          if (options?.onOpen) yield* options.onOpen
          while (true) {
            const message = yield* Queue.take(inbound)
            if (message === end) return
            const handled = handler(message)
            if (Effect.isEffect(handled)) yield* Effect.asVoid(handled)
          }
        }),
      writer: Effect.succeed((message) => Queue.offer(outbound, message).pipe(Effect.asVoid)),
    }),
  }
})

function controlMessage(transport: Effect.Success<typeof makeSocket>) {
  return Queue.take(transport.outbound).pipe(
    Effect.flatMap((message) =>
      typeof message === "string"
        ? BrowserControlProtocol.decodeFromServer(message)
        : Effect.fail(new Error("expected text control message")),
    ),
  )
}

function tunnelMessage(transport: Effect.Success<typeof makeSocket>) {
  return Queue.take(transport.outbound).pipe(
    Effect.flatMap((message) =>
      typeof message === "string"
        ? BrowserTunnelProtocol.decodeFromServer(message)
        : Effect.fail(new Error("expected text tunnel message")),
    ),
  )
}

const echoServer = Effect.acquireRelease(
  Effect.callback<ReturnType<typeof createServer>, Error>((resume) => {
    const server = createServer((socket) => socket.pipe(socket))
    server.once("error", (error) => resume(Effect.fail(error)))
    server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)))
    return Effect.sync(() => server.close())
  }),
  (server) => Effect.sync(() => server.close()),
)
