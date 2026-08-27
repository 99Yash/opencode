import { expect, test } from "bun:test"
import { createServer } from "node:http"
import { NodeHttpServer } from "@effect/platform-node"
import { ClientApi } from "@opencode-ai/protocol/client"
import { SessionNotFoundError } from "@opencode-ai/protocol/errors"
import { fromEndpoint } from "@opencode-ai/protocol/rpc"
import { Event } from "@opencode-ai/schema/event"
import { Session } from "@opencode-ai/schema/session"
import { DateTime, Effect, Schema, Stream } from "effect"
import { RpcGroup, RpcSerialization, RpcServer } from "effect/unstable/rpc"
import { ClientError, isSessionNotFoundError, type OpenCodeClient } from "../src/promise/index.js"
import { OpenCodeRpc } from "../src/promise/rpc.js"

const wire = {
  id: "ses_test",
  projectID: "prj_test",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1700000000000, updated: 1700000001000 },
  location: { directory: "/project" },
}
const info = Schema.decodeUnknownSync(Schema.toCodecJson(Session.Info))(wire)

test("Promise RPC preserves DTOs, numeric queries, optional payloads, errors, bytes and frame headers", async () => {
  await withServer(async (baseUrl, state) => {
    const sockets: WebSocket[] = []
    const client = OpenCodeRpc.make({
      baseUrl,
      headers: {
        authorization: "Basic dXNlcjpwYXNz",
        "x-opencode-directory": "%2Fdefault",
        "x-opencode-workspace": "wrk_default",
      },
      webSocketConstructor: (url, protocols) => {
        expect(new URL(url).pathname).toBe("/api/rpc")
        expect(new URL(url).searchParams.get("auth_token")).toBe("dXNlcjpwYXNz")
        const socket = new WebSocket(url, protocols)
        sockets.push(socket)
        return socket
      },
    })
    const api: OpenCodeClient = client
    expect(sockets).toHaveLength(0)
    try {
      const [health, created, sessions, bytes] = await Promise.all([
        api.health.get(),
        api.session.create(),
        api.session.list({ limit: 2, parentID: null }),
        api.file.read({ path: "dir/space %25.bin", location: { directory: "/explicit", workspace: "wrk_explicit" } }),
      ])
      expect(health.healthy).toBe(true)
      expect(created).toEqual(wire)
      expect(created.time.created).toBeNumber()
      expect(sessions.data).toEqual([wire])
      expect(bytes).toEqual(new Uint8Array([0, 255, 128]))
      expect(await api.session.import({ info: wire, messages: [] })).toEqual(wire)
      expect(await api.session.rename({ sessionID: wire.id, title: "new title" })).toBeUndefined()
      expect(
        await api.form.list(
          { sessionID: "global" },
          {
            headers: {
              "x-opencode-directory": "%2Foverride",
              "x-opencode-workspace": "wrk_override",
              "x-opencode-ticket": "test-ticket",
            },
          },
        ),
      ).toEqual([])
      const form = state.requests.find((request) => request.operation === "session.form.list")!
      expect(form.input).toEqual({ params: { sessionID: "global" } })
      expect(form.headers["x-opencode-directory"]).toBe("%2Foverride")
      expect(form.headers["x-opencode-workspace"]).toBe("wrk_override")
      expect(form.headers["x-opencode-ticket"]).toBe("test-ticket")
      expect(form.headers.authorization).toBeUndefined()
      expect(state.requests.find((request) => request.operation === "session.create")?.input).toEqual({ payload: {} })
      expect(state.requests.find((request) => request.operation === "session.list")?.input).toEqual({
        query: { limit: 2, parentID: null },
      })
      expect(state.requests.find((request) => request.operation === "fs.read")?.input).toEqual({
        params: { path: "dir/space %25.bin" },
        query: { location: { directory: "/explicit", workspace: "wrk_explicit" } },
      })
      const error = await api.session.get({ sessionID: "ses_missing" }).catch((error: unknown) => error)
      expect(isSessionNotFoundError(error)).toBe(true)
      expect(error).toEqual({ _tag: "SessionNotFoundError", sessionID: "ses_missing", message: "missing" })
      expect(error).not.toBeInstanceOf(SessionNotFoundError)
      expect(sockets).toHaveLength(1)
    } finally {
      await client.dispose()
    }
    expect(sockets[0]!.readyState).toBe(WebSocket.CLOSED)
    await expect(client.health.get()).rejects.toBeInstanceOf(ClientError)
    await client.dispose()
    expect(sockets).toHaveLength(1)
  })
})

test("iterator return, AbortSignal and disposal cancel only their owned RPC work", async () => {
  await withServer(async (baseUrl, state) => {
    const client = OpenCodeRpc.make({ baseUrl })
    try {
      const first = client.event.subscribe()[Symbol.asyncIterator]()
      expect((await first.next()).value?.type).toBe("server.connected")
      const pending = first.next()
      await first.return!()
      expect((await pending).done).toBe(true)
      await state.streams[0]!.promise
      expect((await client.health.get()).healthy).toBe(true)

      const abort = new AbortController()
      const second = client.event.subscribe({ signal: abort.signal })[Symbol.asyncIterator]()
      await second.next()
      const blocked = second.next().catch((error: unknown) => error)
      abort.abort()
      expect(await blocked).toBeInstanceOf(ClientError)
      await state.streams[1]!.promise

      const mutationAbort = new AbortController()
      const mutation = client.session
        .remove({ sessionID: wire.id }, { signal: mutationAbort.signal })
        .catch((error: unknown) => error)
      await state.removed.promise
      mutationAbort.abort()
      expect(await mutation).toBeInstanceOf(ClientError)
      await state.removeStopped.promise
      expect((await client.health.get()).healthy).toBe(true)

      const third = client.event.subscribe()[Symbol.asyncIterator]()
      await third.next()
      const disposed = third.next().catch((error: unknown) => error)
      await client.dispose()
      expect(await disposed).toBeInstanceOf(ClientError)
      await state.streams[2]!.promise
      await expect(client.health.get()).rejects.toBeInstanceOf(ClientError)
    } finally {
      await client.dispose()
    }
  })
})

test("disconnect rejects in-flight mutations without replay; only a new facade reconnects", async () => {
  await withServer(async (baseUrl, state) => {
    const sockets: WebSocket[] = []
    const options = {
      baseUrl,
      webSocketConstructor: (url: string, protocols?: string | string[]) => {
        const socket = new WebSocket(url, protocols)
        sockets.push(socket)
        return socket
      },
    }
    const client = OpenCodeRpc.make(options)
    try {
      const mutation = client.session.remove({ sessionID: wire.id }).catch((error: unknown) => error)
      await state.removed.promise
      sockets[0]!.close(1011, "disconnect")
      expect(await mutation).toBeInstanceOf(ClientError)
      await state.removeStopped.promise
      await expect(client.health.get()).rejects.toBeInstanceOf(ClientError)
      expect(sockets).toHaveLength(1)
      const replacement = OpenCodeRpc.make(options)
      try {
        expect((await replacement.health.get()).healthy).toBe(true)
        expect(sockets).toHaveLength(2)
        expect(state.requests.filter((request) => request.operation === "session.remove")).toHaveLength(1)
        await client.dispose()
        expect((await replacement.health.get()).healthy).toBe(true)
      } finally {
        await replacement.dispose()
      }
    } finally {
      await client.dispose()
    }
  })
})

test("disposing an unused facade and pre-aborted calls never open a socket", async () => {
  let sockets = 0
  const options = {
    baseUrl: "http://localhost:1",
    webSocketConstructor: (url: string) => {
      sockets++
      return new WebSocket(url)
    },
  }
  const unused = OpenCodeRpc.make(options)
  await unused.dispose()
  await expect(unused.health.get()).rejects.toBeInstanceOf(ClientError)
  const aborted = OpenCodeRpc.make(options)
  try {
    await expect(aborted.health.get({ signal: AbortSignal.abort() })).rejects.toBeInstanceOf(ClientError)
    await expect(
      aborted.event.subscribe({ signal: AbortSignal.abort() })[Symbol.asyncIterator]().next(),
    ).rejects.toBeInstanceOf(ClientError)
    expect(sockets).toBe(0)
  } finally {
    await aborted.dispose()
  }
})

type State = {
  requests: Array<{ operation: string; input: unknown; headers: Record<string, string> }>
  streams: Array<ReturnType<typeof Promise.withResolvers<void>>>
  removed: ReturnType<typeof Promise.withResolvers<void>>
  removeStopped: ReturnType<typeof Promise.withResolvers<void>>
}

async function withServer(run: (baseUrl: string, state: State) => Promise<void>) {
  await Effect.gen(function* () {
    const state: State = {
      requests: [],
      streams: [],
      removed: Promise.withResolvers(),
      removeStopped: Promise.withResolvers(),
    }
    const record = (operation: string, input: unknown, headers: Record<string, string>) =>
      state.requests.push({ operation, input, headers })
    const group = RpcGroup.make(
      fromEndpoint(ClientApi.groups["server.health"].endpoints["health.get"]),
      fromEndpoint(ClientApi.groups["server.session"].endpoints["session.list"]),
      fromEndpoint(ClientApi.groups["server.session"].endpoints["session.create"]),
      fromEndpoint(ClientApi.groups["server.session"].endpoints["session.import"]),
      fromEndpoint(ClientApi.groups["server.session"].endpoints["session.get"]),
      fromEndpoint(ClientApi.groups["server.session"].endpoints["session.rename"]),
      fromEndpoint(ClientApi.groups["server.session"].endpoints["session.remove"]),
      fromEndpoint(ClientApi.groups["server.form"].endpoints["session.form.list"]),
      fromEndpoint(ClientApi.groups["server.event"].endpoints["event.subscribe"]),
      fromEndpoint(ClientApi.groups["server.fs"].endpoints["fs.read"]),
    )
    const app = yield* RpcServer.toHttpEffectWebsocket(group).pipe(
      Effect.provide(
        group.toLayer({
          "health.get": () => Effect.succeed({ healthy: true, version: "test", pid: 0 }),
          "session.list": (input, options) => {
            record("session.list", input, options.headers)
            return Effect.succeed({ data: [info], cursor: {} })
          },
          "session.create": (input, options) => {
            record("session.create", input, options.headers)
            return Effect.succeed({ data: info })
          },
          "session.import": (input) => {
            expect(DateTime.isDateTime(input.payload.info.time.created)).toBe(true)
            expect(DateTime.toEpochMillis(input.payload.info.time.created)).toBe(wire.time.created)
            return Effect.succeed({ data: input.payload.info })
          },
          "session.get": ({ params }) =>
            Effect.fail(new SessionNotFoundError({ sessionID: params.sessionID, message: "missing" })),
          "session.rename": () => Effect.void,
          "session.remove": (input, options) =>
            Effect.gen(function* () {
              record("session.remove", input, options.headers)
              state.removed.resolve()
              return yield* Effect.never
            }).pipe(Effect.ensuring(Effect.sync(() => state.removeStopped.resolve()))),
          "session.form.list": (input, options) => {
            record("session.form.list", input, options.headers)
            return Effect.succeed({ data: [] })
          },
          "fs.read": (input, options) => {
            record("fs.read", input, options.headers)
            return Effect.succeed({ content: new Uint8Array([0, 255, 128]), mime: "application/octet-stream" })
          },
          "event.subscribe": () => {
            const stopped = Promise.withResolvers<void>()
            state.streams.push(stopped)
            return Stream.make({
              id: Event.ID.make("evt_connected"),
              type: "server.connected" as const,
              data: {},
            }).pipe(Stream.concat(Stream.never), Stream.ensuring(Effect.sync(() => stopped.resolve())))
          },
        }),
      ),
      Effect.provideService(RpcSerialization.RpcSerialization, RpcSerialization.json),
    )
    const server = yield* NodeHttpServer.make(createServer, { host: "127.0.0.1", port: 0 })
    yield* server.serve(app)
    if (server.address._tag !== "TcpAddress") return yield* Effect.die("Expected TCP listener")
    yield* Effect.promise(() =>
      run(`http://127.0.0.1:${server.address._tag === "TcpAddress" ? server.address.port : 0}`, state),
    )
  }).pipe(Effect.scoped, Effect.timeout("10 seconds"), Effect.runPromise)
}
