import { expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { NodeSocket } from "@effect/platform-node"
import { OpenCodeRpc } from "@opencode-ai/protocol/rpc"
import { SessionNotFoundError } from "@opencode-ai/protocol/errors"
import { AbsolutePath } from "@opencode-ai/schema/schema"
import { Pty } from "@opencode-ai/schema/pty"
import { Session } from "@opencode-ai/schema/session"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Queue, Schema, Scope, Stream } from "effect"
import { HttpServer, HttpServerRequest } from "effect/unstable/http"
import { Rpc, RpcClient, RpcGroup, RpcSerialization } from "effect/unstable/rpc"
import { Socket } from "effect/unstable/socket"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { ServerProcess } from "../src/process"

const authorization = `Basic ${btoa("opencode:secret")}`

const fixture = Effect.fn(function* <R extends Rpc.Any>(
  group: RpcGroup.RpcGroup<R>,
  transform?: ServerProcess.Transform,
) {
  const tmp = yield* Effect.acquireRelease(
    Effect.promise(() => tmpdir("opencode-rpc-")),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )
  const global = path.join(tmp.path, "config")
  const directories = [path.join(tmp.path, "first"), path.join(tmp.path, "second")]
  yield* Effect.promise(() => Promise.all([global, ...directories].map((dir) => fs.mkdir(dir))))
  const server = yield* ServerProcess.start<never, never>(
    {
      hostname: "127.0.0.1",
      port: 0,
      password: "secret",
      app: { version: "test-version" },
      database: { path: ":memory:" },
      events: { persist: true },
      config: { directory: global, project: false },
      models: { fetch: false },
      fs: { filewatcher: false, fff: false },
    },
    undefined,
    transform,
  )
  const url = HttpServer.formatAddress(server.address)
  const sockets: WebSocket[] = []
  const protocol = yield* Layer.build(
    RpcClient.layerProtocolSocket({ retryTransientErrors: false }).pipe(
      Layer.provide(RpcSerialization.layerJson),
      Layer.provide(
        Socket.layerWebSocket(new URL("/api/rpc", url).href.replace("http:", "ws:")).pipe(
          Layer.provide(
            Layer.succeed(Socket.WebSocketConstructor, (url) => {
              const socket = new NodeSocket.NodeWS.WebSocket(url, {
                headers: { authorization, origin: "http://localhost:3000" },
              }) as unknown as WebSocket
              sockets.push(socket)
              return socket
            }),
          ),
        ),
      ),
    ),
  )
  const rpc = yield* RpcClient.make(group).pipe(Effect.provideContext(protocol))
  const request = (pathname: string, init?: RequestInit) =>
    Effect.promise(() =>
      fetch(new URL(pathname, url), {
        ...init,
        headers: { authorization, "content-type": "application/json", ...init?.headers },
      }),
    )
  return {
    rpc,
    request,
    url,
    sockets,
    first: { directory: AbsolutePath.make(directories[0]!) },
    second: { directory: AbsolutePath.make(directories[1]!) },
  }
})

it.live(
  "multiplexes concurrent RPC calls and shares session state with HTTP",
  () =>
    Effect.gen(function* () {
      const { rpc, request, first, sockets } = yield* fixture(OpenCodeRpc.Group)
      const sessions = yield* Effect.all(
        Array.from({ length: 8 }, (_, index) =>
          rpc["session.create"]({ payload: { title: `parallel-${index}`, location: first } }),
        ),
        { concurrency: "unbounded" },
      )
      expect(new Set(sessions.map((session) => session.data.id)).size).toBe(8)
      expect(sessions.map((session) => session.data.title)).toEqual(
        Array.from({ length: 8 }, (_, index) => `parallel-${index}`),
      )
      const sessionID = sessions[0]!.data.id
      const http = yield* request(`/api/session/${sessionID}`)
      expect(http.status).toBe(200)
      expect(
        Schema.decodeUnknownSync(Schema.Struct({ data: Session.Info }))(yield* Effect.promise(() => http.json())),
      ).toEqual(yield* rpc["session.get"]({ params: { sessionID } }))

      expect(
        yield* rpc["session.rename"]({ params: { sessionID }, payload: { title: "renamed by RPC" } }),
      ).toBeUndefined()
      const renamed = yield* request(`/api/session/${sessionID}`)
      expect(yield* Effect.promise(() => renamed.json())).toMatchObject({ data: { title: "renamed by RPC" } })

      expect(
        (yield* request(`/api/session/${sessionID}/rename`, {
          method: "POST",
          body: JSON.stringify({ title: "renamed by HTTP" }),
        })).status,
      ).toBe(204)
      expect((yield* rpc["session.get"]({ params: { sessionID } })).data.title).toBe("renamed by HTTP")
      expect(yield* rpc["session.remove"]({ params: { sessionID } })).toBeUndefined()
      const missing = yield* rpc["session.get"]({ params: { sessionID } }).pipe(
        Effect.catchTag("SessionNotFoundError", Effect.succeed),
      )
      expect(missing).toBeInstanceOf(SessionNotFoundError)
      expect(missing).toMatchObject({ _tag: "SessionNotFoundError", sessionID })
      const absent = yield* request(`/api/session/${sessionID}`)
      expect(absent.status).toBe(404)
      expect(yield* Effect.promise(() => absent.json())).toMatchObject({ _tag: "SessionNotFoundError", sessionID })
      expect(sockets).toHaveLength(1)
    }).pipe(Effect.timeout("20 seconds")),
  30_000,
)

it.live(
  "reads binary files and MIME types at two locations over one RPC connection",
  () =>
    Effect.gen(function* () {
      const { rpc, request, first, second, sockets } = yield* fixture(OpenCodeRpc.Group)
      const filename = "space # percent% question? plus+.png"
      const firstBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 255, 128])
      const secondBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 127, 1, 254])
      yield* Effect.promise(() =>
        Promise.all([
          Bun.write(path.join(first.directory, filename), firstBytes),
          Bun.write(path.join(second.directory, filename), secondBytes),
        ]),
      )
      const files = yield* Effect.all(
        [first, second].map((location) => rpc["fs.read"]({ params: { path: filename }, query: {}, location })),
        { concurrency: "unbounded" },
      )
      expect(files.map((file) => file.content)).toEqual([firstBytes, secondBytes])
      expect(files.map((file) => file.mime)).toEqual(["image/png", "image/png"])
      const query = new URLSearchParams({ "location[directory]": first.directory })
      const http = yield* request(`/api/fs/read/${encodeURIComponent(filename)}?${query}`)
      expect(http.status).toBe(200)
      expect(http.headers.get("content-type")).toBe(files[0]!.mime)
      expect(Array.from(new Uint8Array(yield* Effect.promise(() => http.arrayBuffer())))).toEqual(
        Array.from(files[0]!.content),
      )
      const lists = yield* Effect.all(
        [first, second].map((location) => rpc["fs.list"]({ query: {}, location })),
        { concurrency: "unbounded" },
      )
      expect(lists.map((list) => list.location.directory)).toEqual([first.directory, second.directory])
      expect(sockets).toHaveLength(1)
    }).pipe(Effect.timeout("20 seconds")),
  30_000,
)

it.live(
  "streams the connected event and later domain events alongside unary RPC calls",
  () =>
    Effect.gen(function* () {
      const { rpc, first, sockets } = yield* fixture(OpenCodeRpc.Group)
      yield* Effect.gen(function* () {
        const events = yield* rpc["event.subscribe"]({}, { asQueue: true })
        expect(yield* Queue.take(events)).toMatchObject({ type: "server.connected", data: {} })
        const created = yield* rpc["session.create"]({ payload: { title: "observed", location: first } })
        const received = yield* Stream.fromQueue(events).pipe(
          Stream.filter((event) => event.type === "session.created"),
          Stream.take(1),
          Stream.runCollect,
        )
        expect(received).toMatchObject([{ type: "session.created", data: { sessionID: created.data.id } }])
      }).pipe(Effect.scoped)
      expect(yield* rpc["health.get"]({})).toMatchObject({ healthy: true, version: "test-version" })
      expect(sockets).toHaveLength(1)
    }).pipe(Effect.timeout("20 seconds")),
  30_000,
)

it.live(
  "cancels event subscriptions without accumulating upgrade finalizers",
  () =>
    Effect.gen(function* () {
      const captured = yield* Deferred.make<Scope.Scope>()
      const { rpc, sockets } = yield* fixture(OpenCodeRpc.Group, (app) =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest
          if (request.url === "/api/rpc") {
            const scope = yield* Scope.Scope
            yield* Deferred.succeed(captured, scope)
          }
          return yield* app
        }),
      )
      yield* rpc["health.get"]({})
      const scope = yield* Deferred.await(captured)
      const finalizerCount = () => {
        const state = scope.state
        if (state._tag !== "Open") throw new Error("WebSocket upgrade scope must remain open")
        return state.finalizers.size
      }
      const baseline = finalizerCount()
      for (let index = 0; index < 5; index++) {
        yield* Effect.gen(function* () {
          const events = yield* rpc["event.subscribe"]({}, { asQueue: true })
          expect(yield* Queue.take(events)).toMatchObject({ type: "server.connected" })
          // The subscription belongs to its RPC scope even while it is active.
          expect(finalizerCount()).toBe(baseline)
        }).pipe(Effect.scoped)
        expect(yield* rpc["health.get"]({})).toMatchObject({ healthy: true, version: "test-version" })
        expect(finalizerCount()).toBe(baseline)
      }
      expect(sockets).toHaveLength(1)
    }).pipe(Effect.timeout("20 seconds")),
  30_000,
)

it.live(
  "replays session logs and cancels a live stream without closing the RPC connection",
  () =>
    Effect.gen(function* () {
      const { rpc, first, sockets } = yield* fixture(OpenCodeRpc.Group)
      const session = yield* rpc["session.create"]({ payload: { title: "before replay", location: first } })
      const params = { sessionID: session.data.id }
      yield* rpc["session.rename"]({ params, payload: { title: "in replay" } })
      const replay = yield* rpc["session.log"]({ params, query: { follow: false } }).pipe(Stream.runCollect)
      expect(replay.map((event) => event.type)).toEqual(["session.created", "session.renamed", "log.synced"])
      expect(replay[1]).toMatchObject({ data: { sessionID: params.sessionID, title: "in replay" } })
      const watermark = replay.find((event) => event.type === "log.synced")!
      expect(watermark).toMatchObject({ type: "log.synced", aggregateID: params.sessionID })

      const synced = yield* Deferred.make<void>()
      const renamed = yield* Deferred.make<void>()
      const follow = yield* rpc["session.log"]({ params, query: { after: watermark.seq, follow: true } }).pipe(
        Stream.runForEach((event) =>
          event.type === "log.synced"
            ? Deferred.succeed(synced, undefined)
            : event.type === "session.renamed" && event.data.title === "after replay"
              ? Deferred.succeed(renamed, undefined)
              : Effect.void,
        ),
        Effect.forkScoped,
      )
      yield* Deferred.await(synced)
      yield* rpc["session.rename"]({ params, payload: { title: "after replay" } })
      yield* Deferred.await(renamed)
      yield* Fiber.interrupt(follow)
      expect((yield* rpc["session.get"]({ params })).data.title).toBe("after replay")
      expect(yield* rpc["health.get"]({})).toMatchObject({ healthy: true })
      expect(sockets).toHaveLength(1)
    }).pipe(Effect.timeout("20 seconds")),
  30_000,
)

it.live(
  "validates malformed RPC payloads on the server without poisoning the connection",
  () =>
    Effect.gen(function* () {
      // The permissive client codec sends invalid data instead of rejecting it before transport.
      const { rpc, request, first, sockets } = yield* fixture(
        RpcGroup.make(
          Rpc.make("session.create", { payload: Schema.Unknown, success: Schema.Unknown, error: Schema.Unknown }),
          Rpc.make("health.get", { payload: Schema.Unknown, success: Schema.Unknown, error: Schema.Unknown }),
        ),
      )
      const invalid = yield* rpc["session.create"]({ payload: { title: 42, location: first } }).pipe(Effect.exit)
      expect(Exit.isFailure(invalid)).toBe(true)
      if (Exit.isFailure(invalid)) expect(Cause.pretty(invalid.cause)).toContain("title")
      const http = yield* request("/api/session", {
        method: "POST",
        body: JSON.stringify({ title: 42, location: first }),
      })
      expect(http.status).toBe(400)
      const list = yield* request("/api/session")
      expect(yield* Effect.promise(() => list.json())).toMatchObject({ data: [] })
      expect(yield* rpc["health.get"]({})).toMatchObject({ healthy: true })
      expect(sockets).toHaveLength(1)
    }).pipe(Effect.timeout("20 seconds")),
  30_000,
)

it.live(
  "rejects missing credentials and untrusted browser origins before upgrading RPC",
  () =>
    Effect.gen(function* () {
      const { rpc, url } = yield* fixture(OpenCodeRpc.Group)
      const denied = yield* Effect.all(
        [
          new Headers(),
          new Headers({ authorization: `Basic ${btoa("opencode:wrong")}` }),
          new Headers({ authorization, origin: "https://untrusted.example" }),
          new Headers({ authorization, origin: "null" }),
        ].map((headers) => Effect.promise(() => fetch(new URL("/api/rpc", url), { headers }))),
        { concurrency: "unbounded" },
      )
      expect(denied.map((response) => response.status)).toEqual([401, 401, 403, 403])
      expect(denied.every((response) => !response.headers.has("sec-websocket-accept"))).toBe(true)
      expect(yield* rpc["health.get"]({})).toMatchObject({ healthy: true })
    }).pipe(Effect.timeout("20 seconds")),
  30_000,
)

it.live(
  "forwards declared PTY ticket headers to the shared business handler",
  () =>
    Effect.gen(function* () {
      const { rpc, first } = yield* fixture(OpenCodeRpc.Group)
      const input = { params: { ptyID: Pty.ID.make("pty_missing") }, query: {}, location: first }
      const denied = yield* rpc["pty.connectToken"]({ ...input, headers: {} }).pipe(
        Effect.catchTag("ForbiddenError", Effect.succeed),
      )
      expect(denied).toMatchObject({ _tag: "ForbiddenError" })
      const missing = yield* rpc["pty.connectToken"]({ ...input, headers: { "x-opencode-ticket": "1" } }).pipe(
        Effect.catchTag("PtyNotFoundError", Effect.succeed),
      )
      expect(missing).toMatchObject({ _tag: "PtyNotFoundError", ptyID: input.params.ptyID })
    }).pipe(Effect.timeout("20 seconds")),
  30_000,
)
