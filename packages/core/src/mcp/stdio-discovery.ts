export * as McpStdioDiscovery from "./stdio-discovery.js"

import {
  Client,
  SdkError,
  SdkErrorCode,
  type ClientCapabilities,
  type Implementation,
  type PriorDiscovery,
} from "@modelcontextprotocol/client"
import { Effect } from "effect"
import { McpStdio } from "./stdio.js"

/** Probe a disposable location-owned child; never spend the real child's first request on discovery. */
export const discover = Effect.fnUntraced(function* (
  options: McpStdio.Options,
  clientInfo: Implementation,
  capabilities: ClientCapabilities,
  startupTimeout: number,
) {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const abort = new AbortController()
      const transport = yield* McpStdio.make(options, abort.signal)
      const client = new Client(clientInfo, {
        capabilities,
        versionNegotiation: { mode: "auto", probe: { timeoutMs: startupTimeout, maxRetries: 0 } },
      })
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          abort.abort()
          await client.close()
          await transport.close()
        }),
      )

      const legacy = new Error("Discovery selected legacy initialization")
      const state: { closed: boolean; closing: boolean; error?: Error } = { closed: false, closing: false }
      const close = transport.close.bind(transport)
      transport.close = () => {
        state.closing = true
        return close()
      }
      transport.onclose = () => {
        if (!state.closing) state.closed = true
      }
      transport.onerror = (error) => {
        state.error = error
      }
      const send = transport.send.bind(transport)
      // The SDK's standalone classifier is private. Let auto negotiation classify the reply, but
      // stop its legacy handshake here: only the fresh session child should receive initialize.
      transport.send = (message, options) =>
        "method" in message && message.method === "initialize" ? Promise.reject(legacy) : send(message, options)

      // Bound spawning separately: a pending spawn is an error, while the SDK classifies a silent
      // spawned child as legacy. Do not time out SDK cleanup after it has already received an error.
      yield* Effect.tryPromise({
        try: () => transport.start(),
        catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      }).pipe(Effect.timeout(startupTimeout))
      transport.start = () => Promise.resolve()

      yield* Effect.tryPromise({
        try: (signal) => client.connect(transport, { signal, timeout: startupTimeout }),
        catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      }).pipe(
        Effect.catch((error) => {
          if (state.error) return Effect.fail(state.error)
          if (
            error === legacy ||
            (state.closed && error instanceof SdkError && error.code === SdkErrorCode.EraNegotiationFailed)
          )
            return Effect.void
          return Effect.fail(error)
        }),
      )

      const result = client.getDiscoverResult()
      return result
        ? ({ kind: "modern", discover: result } satisfies PriorDiscovery)
        : ({ kind: "legacy" } satisfies PriorDiscovery)
    }),
  )
})
