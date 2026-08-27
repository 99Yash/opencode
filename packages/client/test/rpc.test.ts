import { expect, test } from "bun:test"
import { createServer } from "node:http"
import { NodeHttpServer } from "@effect/platform-node"
import { ClientApi } from "@opencode-ai/protocol/client"
import { SessionNotFoundError } from "@opencode-ai/protocol/errors"
import { Group, fromEndpoint } from "@opencode-ai/protocol/rpc"
import { Event } from "@opencode-ai/schema/event"
import { Session } from "@opencode-ai/schema/session"
import { Deferred, Effect, Fiber, Redacted, Stream } from "effect"
import { RpcGroup, RpcSerialization, RpcServer } from "effect/unstable/rpc"
import { OpenCodeRpc } from "../src/effect/rpc.js"

test("one scoped socket multiplexes unary calls and cancellable typed streams", async () => {
  const sockets: WebSocket[] = []
  await Effect.gen(function* () {
    const started = yield* Deferred.make<void>()
    const stopped = yield* Deferred.make<void>()
    const group = RpcGroup.make(
      fromEndpoint(ClientApi.groups["server.health"].endpoints["health.get"]),
      fromEndpoint(ClientApi.groups["server.session"].endpoints["session.list"]),
      fromEndpoint(ClientApi.groups["server.session"].endpoints["session.get"]),
      fromEndpoint(ClientApi.groups["server.session"].endpoints["session.remove"]),
      fromEndpoint(ClientApi.groups["server.event"].endpoints["event.subscribe"]),
      fromEndpoint(ClientApi.groups["server.fs"].endpoints["fs.read"]),
    )
    const app = yield* RpcServer.toHttpEffectWebsocket(group).pipe(
      Effect.provide(
        group.toLayer({
          "health.get": () => Effect.succeed({ healthy: true, version: "test", pid: 0 }),
          "session.list": () => Effect.succeed({ data: [], cursor: {} }),
          "session.get": ({ params }) =>
            Effect.fail(new SessionNotFoundError({ sessionID: params.sessionID, message: "missing" })),
          "session.remove": () => Effect.void,
          "fs.read": () => Effect.succeed({ content: new Uint8Array([0, 255, 128]), mime: "application/octet-stream" }),
          "event.subscribe": () =>
            Stream.fromEffect(Deferred.succeed(started, undefined)).pipe(
              Stream.map(() => ({ id: Event.ID.make("evt_connected"), type: "server.connected" as const, data: {} })),
              Stream.concat(Stream.never),
              Stream.ensuring(Deferred.succeed(stopped, undefined)),
            ),
        }),
      ),
      Effect.provideService(RpcSerialization.RpcSerialization, RpcSerialization.json),
    )
    const server = yield* NodeHttpServer.make(createServer, { host: "127.0.0.1", port: 0 })
    yield* server.serve(app)
    if (server.address._tag !== "TcpAddress") return yield* Effect.die("Expected TCP listener")
    yield* Effect.scoped(
      Effect.gen(function* () {
        const client = yield* OpenCodeRpc.make({
          url: `ws://127.0.0.1:${server.address._tag === "TcpAddress" ? server.address.port : 0}/api/rpc`,
          authToken: Redacted.make("test-token"),
          webSocketConstructor: (url, protocols) => {
            expect(new URL(url).searchParams.get("auth_token")).toBe("test-token")
            const socket = new WebSocket(url, protocols)
            sockets.push(socket)
            return socket
          },
        })
        const received = yield* Deferred.make<void>()
        const events = yield* client["event.subscribe"]({}).pipe(
          Stream.runForEach((event) => {
            expect(event.type).toBe("server.connected")
            return Deferred.succeed(received, undefined)
          }),
          Effect.forkScoped,
        )
        yield* Deferred.await(started)
        yield* Deferred.await(received)
        const [health, sessions, file] = yield* Effect.all(
          [
            client["health.get"]({}),
            client["session.list"]({ query: {} }),
            client["fs.read"]({ params: { path: "a.bin" }, query: {} }),
          ],
          { concurrency: "unbounded" },
        )
        expect(health).toEqual({ healthy: true, version: "test", pid: 0 })
        expect(sessions).toEqual({ data: [], cursor: {} })
        expect(file.content).toEqual(new Uint8Array([0, 255, 128]))
        const error = yield* client["session.get"]({ params: { sessionID: Session.ID.make("ses_missing") } }).pipe(
          Effect.flip,
        )
        expect(error).toBeInstanceOf(SessionNotFoundError)
        expect(yield* client["session.remove"]({ params: { sessionID: Session.ID.make("ses_test") } })).toBeUndefined()
        yield* Fiber.interrupt(events)
        yield* Deferred.await(stopped)
        expect((yield* client["health.get"]({})).healthy).toBe(true)
        expect(sockets).toHaveLength(1)
      }),
    )
  }).pipe(Effect.scoped, Effect.timeout("10 seconds"), Effect.runPromise)
  expect(sockets[0]!.readyState).toBe(WebSocket.CLOSED)
})

// The derived client keeps operation-specific request and response types.
type Client = Effect.Success<ReturnType<typeof OpenCodeRpc.make>>
type HasRawPty = "pty.connect" extends keyof Client ? true : false
const noRawPty: HasRawPty = false
type Tags = RpcGroup.Rpcs<typeof Group>["_tag"]
const fileTag: Tags = "fs.read"
test("raw PTY is not part of the typed client", () => {
  expect(noRawPty).toBe(false)
  expect(fileTag).toBe("fs.read")
})
