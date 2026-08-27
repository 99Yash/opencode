export * as OpenCodeRpc from "./rpc.js"

import { Group, type Rpcs } from "@opencode-ai/protocol/rpc"
import { Effect, Redacted, Schedule, Scope } from "effect"
import { RpcClient, RpcClientError, RpcSerialization } from "effect/unstable/rpc"
import { Socket } from "effect/unstable/socket"

export interface Options {
  /** Full WebSocket endpoint, for example wss://opencode.example/api/rpc. */
  readonly url: string | URL
  /** Existing server auth_token, sent only during the WebSocket upgrade. */
  readonly authToken?: Redacted.Redacted<string>
  readonly webSocketConstructor?: Socket.WebSocketConstructor["Service"]
}

export type Client = RpcClient.RpcClient<Rpcs, RpcClientError.RpcClientError>

/** One scoped connection multiplexes all unary calls and streaming subscriptions. */
export const make: (options: Options) => Effect.Effect<Client, never, Scope.Scope> = Effect.fnUntraced(
  function* (options) {
    const url = new URL(options.url)
    if (options.authToken) url.searchParams.set("auth_token", Redacted.value(options.authToken))
    const socket = yield* Socket.makeWebSocket(url.toString()).pipe(
      Effect.provideService(
        Socket.WebSocketConstructor,
        options.webSocketConstructor ?? ((url, protocols) => new WebSocket(url, protocols)),
      ),
    )
    const protocol = yield* RpcClient.makeProtocolSocket({ retryPolicy: Schedule.recurs(0) }).pipe(
      Effect.provideService(Socket.Socket, socket),
      Effect.provideService(RpcSerialization.RpcSerialization, RpcSerialization.json),
    )
    return yield* RpcClient.make(Group).pipe(Effect.provideService(RpcClient.Protocol, protocol))
  },
)
