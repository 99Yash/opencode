import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ClientApi } from "@opencode-ai/protocol/client"
import { OpenCodeRpc } from "@opencode-ai/protocol/rpc"
import { AbsolutePath } from "@opencode-ai/schema/schema"
import { Effect, Layer } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpServer } from "effect/unstable/http"
import { HttpApiClient } from "effect/unstable/httpapi"
import { RpcClient, RpcSerialization } from "effect/unstable/rpc"
import { Socket } from "effect/unstable/socket"
import { ServerProcess } from "../src/process"

// A loopback transport microbenchmark, not an end-to-end desktop performance claim.
// Both clients decode the same schemas and read the same 50-session page.
await Effect.gen(function* () {
  const directory = yield* Effect.acquireRelease(
    Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "opencode-rpc-bench-"))),
    (directory) => Effect.promise(() => fs.rm(directory, { recursive: true, force: true })),
  )
  const password = crypto.randomUUID()
  const server = yield* ServerProcess.start<never, never>({
    hostname: "127.0.0.1",
    port: 0,
    password,
    database: { path: ":memory:" },
    config: { directory: path.join(directory, "config"), project: false },
    models: { fetch: false },
    fs: { filewatcher: false, fff: false },
  })
  const url = HttpServer.formatAddress(server.address)
  const http = yield* HttpApiClient.make(ClientApi, {
    baseUrl: url,
    transformClient: (client) =>
      HttpClient.mapRequest(
        client,
        HttpClientRequest.setHeader("authorization", `Basic ${btoa(`opencode:${password}`)}`),
      ),
  }).pipe(Effect.provide(FetchHttpClient.layer))
  const socket = new URL("/api/rpc", url)
  socket.protocol = "ws:"
  socket.searchParams.set("auth_token", btoa(`opencode:${password}`))
  const protocol = yield* Layer.build(
    RpcClient.layerProtocolSocket({ retryTransientErrors: false }).pipe(
      Layer.provide(RpcSerialization.layerJson),
      Layer.provide(Socket.layerWebSocket(socket.href).pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal))),
    ),
  )
  const rpc = yield* RpcClient.make(OpenCodeRpc.Group).pipe(Effect.provideContext(protocol))
  yield* Effect.forEach(
    Array.from({ length: 50 }, (_, index) => index),
    (index) =>
      rpc["session.create"]({
        payload: { title: `Benchmark ${index}`, location: { directory: AbsolutePath.make(directory) } },
      }),
  )
  const calls: ReadonlyArray<{ transport: string; call: Effect.Effect<unknown, unknown> }> = [
    { transport: "HTTP", call: http["server.session"]["session.list"]({ query: {} }) },
    { transport: "RPC", call: rpc["session.list"]({ query: {} }) },
  ]
  for (const concurrency of [1, 16]) {
    for (const { transport, call } of calls) {
      yield* Effect.forEach(Array.from({ length: 30 }), () => call, { concurrency })
      const start = performance.now()
      const samples = yield* Effect.forEach(
        Array.from({ length: 300 }),
        () =>
          Effect.gen(function* () {
            const start = performance.now()
            yield* call
            return performance.now() - start
          }),
        { concurrency },
      )
      const total = performance.now() - start
      samples.sort((a, b) => a - b)
      console.log(
        JSON.stringify({
          transport,
          concurrency,
          requests: samples.length,
          elapsedMs: Math.round(total),
          requestsPerSecond: Math.round((samples.length / total) * 1000),
          p50Ms: Number(samples[Math.floor(samples.length * 0.5)]!.toFixed(2)),
          p95Ms: Number(samples[Math.floor(samples.length * 0.95)]!.toFixed(2)),
        }),
      )
    }
  }
}).pipe(Effect.timeout("60 seconds"), Effect.scoped, Effect.runPromise)
