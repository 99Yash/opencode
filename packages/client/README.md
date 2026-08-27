# @opencode-ai/client

Private generation target for clients derived directly from OpenCode's authoritative Effect `HttpApi`.

## Entrypoints

- `@opencode-ai/client`: zero-Effect Promise client using `fetch`.
- `@opencode-ai/client/promise/rpc`: the same Promise DTO surface over a lazy, shared WebSocket (imports Effect).
- `@opencode-ai/client/effect`: rich Effect network client using an environment-provided `HttpClient`.
- `@opencode-ai/client/effect/rpc`: native Effect RPC over a single scoped WebSocket.

The generated surface includes every standard HTTP group from Server's concrete API. The build compiler reads `@opencode-ai/server/api`; the generated Effect runtime imports a client-local projection built from Protocol, with a generation-equivalence test preventing transport drift. Custom transports such as the PTY WebSocket connection remain outside the generic HTTP client. Run `bun run generate` after changing the contract and `bun run check:generated` to detect committed-output drift.

The Effect entrypoint uses canonical decoded values such as `Session.ID`, `Location.Ref`, and `Prompt`. These datatypes come from the lightweight `@opencode-ai/schema` package and are re-exported so callers depend only on the client surface. Protocol owns endpoint construction and middleware placement; Server supplies the concrete middleware keys used by the build-time API.

The Promise root remains structural and has no Core or Effect runtime dependency. `/effect` depends only on Effect, Schema, and Protocol and is browser-bundle safe. Bundle-boundary tests enforce both import graphs.

Effect consumers construct canonical decoded inputs:

```ts
import { AbsolutePath, Location, OpenCode, Prompt } from "@opencode-ai/client/effect"

const client = yield * OpenCode.make({ baseUrl: "https://opencode.example" })
yield *
  client.sessions.create({
    location: Location.Ref.make({ directory: AbsolutePath.make("/workspace") }),
  })
yield * client.sessions.prompt({ sessionID, prompt: Prompt.make({ text: "Hello" }) })
```

## WebSocket RPC

Promise consumers can keep their existing method calls and wire DTOs:

```ts
import { OpenCodeRpc } from "@opencode-ai/client/promise/rpc"

const client = OpenCodeRpc.make({
  baseUrl: "https://opencode.example",
  headers: { authorization: `Basic ${token}` },
})
try {
  const session = await client.session.create()
  // Numeric timestamps, not Effect DateTime values.
  console.log(session.time.created)
} finally {
  await client.dispose()
}
```

`make` returns synchronously without opening a socket. The first call or stream iteration opens one shared connection. Basic authorization is used only for the upgrade's `auth_token`; other default and per-call headers travel as RPC frame metadata. Per-call headers override endpoint headers, which override facade defaults. Binary `file.read` results remain `Uint8Array`, and declared errors remain plain wire objects accepted by the Promise error guards.

Breaking or returning from an async iterator cancels its subscription. `RequestOptions.signal` cancels one call or stream without closing unrelated work. `dispose()` is idempotent, closes the connection, and rejects subsequent calls. A failed connection is never retried and in-flight requests are never replayed: dispose the failed facade and create a new one to reconnect. The Promise root stays zero-Effect; only the explicit `/promise/rpc` entrypoint imports the native RPC runtime.

The additive `/api/rpc` transport derives its operation contracts from Protocol's HTTP schemas; existing HTTP clients are unchanged. Use operation identifiers directly, with decoded `params`, `query`, and `payload` fields where declared. Numeric queries are numbers, not HTTP strings. Optional `location: { directory, workspace? }` selects per-call location context; session-specific operations retain their existing session location rules.

```ts
import { OpenCodeRpc } from "@opencode-ai/client/effect/rpc"
import { Effect, Redacted, Stream } from "effect"

declare const token: string // Base64 of "opencode:<server password>", not the raw password.

const program = Effect.gen(function* () {
  const client = yield* OpenCodeRpc.make({
    url: "wss://opencode.example/api/rpc",
    authToken: Redacted.make(token),
  })
  const events = yield* client["event.subscribe"]({}).pipe(
    Stream.runForEach((event) => Effect.log(event.type)),
    Effect.forkScoped,
  )
  const sessions = yield* client["session.list"]({ query: {} })
  // Both requests share the connection; interrupting events cancels only that subscription.
  return sessions
})

Effect.runPromise(Effect.scoped(program))
```

Keep the scope open while consuming streams. Scope closure closes the socket and cancels outstanding work. Connection failures are surfaced rather than replaying potentially mutating requests; create a new scoped client to reconnect. Browsers use their native WebSocket constructor, with an optional `webSocketConstructor` override for other runtimes. Authentication uses the server's existing `auth_token` upgrade mechanism; treat the resulting URL as sensitive and do not log it.

Streaming operations return native Effect Streams of the original typed items, not SSE text. No-content operations return `void`. `fs.read` takes `params: { path: "relative/file" }` plus `query: {}` and returns `{ content: Uint8Array, mime: string }`, with bytes encoded as base64 on the wire. Raw `pty.connect` and `persistentPty.connect` remain on their existing WebSocket routes.

From `packages/server`, run `bun run script/benchmark-rpc.ts` for an isolated loopback comparison of HTTP and RPC session-list calls. It uses an in-memory database, temporary configuration, and schema-decoding clients at concurrency 1 and 16. This measures transport overhead, not end-to-end desktop/web speed. Desktop injects the Promise RPC transport; browser web retains HTTP. Desktop service discovery/readiness checks and raw terminal attachments keep their existing transports.
