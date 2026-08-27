export * as OpenCodeRpc from "./rpc.js"

import { ClientApi } from "@opencode-ai/protocol/client"
import { Group } from "@opencode-ai/protocol/rpc"
import { Effect, Exit, Redacted, Schema, Scope, Stream } from "effect"
import type { HttpApi } from "effect/unstable/httpapi"
import { RpcClientError, RpcSchema } from "effect/unstable/rpc"
import { OpenCodeRpc } from "../effect/rpc.js"
import { ClientError } from "./generated/client-error.js"
import { OpenCode } from "./generated/index.js"
import type { ClientOptions, RequestDescriptor, RequestOptions } from "./generated/client.js"
import type { OpenCodeClient } from "./index.js"

export interface Options extends Pick<ClientOptions, "baseUrl" | "headers"> {
  readonly webSocketConstructor?: OpenCodeRpc.Options["webSocketConstructor"]
}

export type Client = OpenCodeClient & { readonly dispose: () => Promise<void> }

const endpoints = new Map(
  Object.values((ClientApi as unknown as HttpApi.Top).groups).flatMap((group) =>
    Object.values(group.endpoints).map((endpoint) => [endpoint.identifier, endpoint] as const),
  ),
)

const codecs = new Map<
  string,
  {
    readonly input: Schema.Codec<unknown, unknown>
    readonly output: Schema.Codec<unknown, unknown>
    readonly error: Schema.Codec<unknown, unknown>
  }
>()

function operation(name: string) {
  const cached = codecs.get(name)
  if (cached) return cached
  const endpoint = endpoints.get(name)
  const rpc = Group.requests.get(name)
  if (!endpoint || !rpc) throw new ClientError("Transport", { cause: new Error(`Unknown RPC operation: ${name}`) })
  const payloads = Array.from(endpoint.payload.values()).flatMap((entry) => entry.schemas)
  const output = RpcSchema.isStreamSchema(rpc.successSchema) ? rpc.successSchema.success : rpc.successSchema
  // Promise query inputs are decoded values; payloads and path/header inputs are HTTP wire values.
  const input = Schema.Struct({
    ...(endpoint.params && name !== "fs.read" ? { params: Schema.toCodecJson(endpoint.params) } : {}),
    ...(name === "fs.read" ? { params: Schema.Struct({ path: Schema.String }) } : {}),
    ...(endpoint.query ? { query: Schema.toCodecJson(Schema.toType(endpoint.query)) } : {}),
    ...(endpoint.headers ? { headers: Schema.toCodecJson(endpoint.headers) } : {}),
    ...(payloads.length ? { payload: Schema.toCodecJson(Schema.Union(payloads)) } : {}),
  })
  const error = RpcSchema.isStreamSchema(rpc.successSchema)
    ? Schema.Union([rpc.errorSchema, rpc.successSchema.error])
    : rpc.errorSchema
  const value = { input: Schema.fromJsonString(input), output, error } as unknown as {
    input: Schema.Codec<unknown, unknown>
    output: Schema.Codec<unknown, unknown>
    error: Schema.Codec<unknown, unknown>
  }
  codecs.set(name, value)
  return value
}

/** A lazy, single-connection Promise facade. Replace it after a disconnect; calls are never replayed. */
export function make(options: Options): Client {
  const scope = Scope.makeUnsafe()
  let client: Promise<OpenCodeRpc.Client> | undefined
  let disposal: Promise<void> | undefined
  const connect = Effect.suspend(() => {
    if (disposal) return Effect.fail(new ClientError("Transport", { cause: new Error("RPC client disposed") }))
    return Effect.promise(
      () =>
        (client ??= Effect.runPromise(
          Effect.gen(function* () {
            const url = new URL("/api/rpc", options.baseUrl)
            url.protocol = url.protocol === "https:" || url.protocol === "wss:" ? "wss:" : "ws:"
            const authorization = new Headers(options.headers).get("authorization")
            const token = /^Basic\s+(.+)$/i.exec(authorization ?? "")?.[1]
            return yield* OpenCodeRpc.make({
              url,
              authToken: token ? Redacted.make(token) : undefined,
              webSocketConstructor: options.webSocketConstructor,
            })
          }).pipe(Effect.provideService(Scope.Scope, scope)),
        )),
    )
  })

  const invoke = Effect.fnUntraced(function* (descriptor: RequestDescriptor, requestOptions: RequestOptions) {
    if (requestOptions.signal?.aborted)
      return yield* Effect.fail(new ClientError("Transport", { cause: requestOptions.signal.reason }))
    const codec = operation(descriptor.operation)
    const headers = new Headers(requestOptions.headers)
    // Authentication belongs only to the upgrade, not to user-controlled RPC frames.
    headers.delete("authorization")
    // Match the Promise wire boundary: omit undefined optional fields before decoding JSON codecs.
    const input = yield* Schema.decodeUnknownEffect(codec.input)(
      JSON.stringify({
        params: descriptor.params,
        query: descriptor.query ?? {},
        payload: descriptor.body === undefined ? {} : descriptor.body,
        headers: Object.fromEntries(headers),
      }),
    ).pipe(Effect.mapError((cause) => new ClientError("Transport", { cause })))
    const api = yield* connect
    // The generated operation/descriptor and protocol codec jointly establish this dynamic boundary.
    const call = (
      api as unknown as Record<
        string,
        (
          input: unknown,
          options: { headers: Record<string, string> },
        ) => Effect.Effect<unknown, unknown> | Stream.Stream<unknown, unknown>
      >
    )[descriptor.operation]!
    return call(input, { headers: Object.fromEntries(headers) })
  })

  return Object.assign(
    OpenCode.make({
      ...options,
      transport: {
        request(descriptor, requestOptions) {
          const codec = operation(descriptor.operation)
          return Effect.runPromise(
            Effect.gen(function* () {
              const result = yield* invoke(descriptor, requestOptions)
              if (Stream.isStream(result)) return yield* Effect.fail(new ClientError("MalformedResponse"))
              const value = yield* result
              if (descriptor.empty) return undefined
              if (descriptor.binary) return (value as { content: Uint8Array }).content
              return yield* Schema.encodeUnknownEffect(codec.output)(value).pipe(
                Effect.mapError((cause) => new ClientError("MalformedResponse", { cause })),
              )
            }),
            { signal: requestOptions.signal },
          ).catch((error) => {
            throw wireError(error, codec.error)
          })
        },
        stream(descriptor, requestOptions) {
          const codec = operation(descriptor.operation)
          const stream = Stream.unwrap(
            invoke(descriptor, requestOptions).pipe(
              Effect.map((result) =>
                Stream.isStream(result) ? result : Stream.fail(new ClientError("MalformedResponse")),
              ),
            ),
          ).pipe(
            Stream.mapEffect((value) =>
              Schema.encodeUnknownEffect(codec.output)(value).pipe(
                Effect.mapError((cause) => new ClientError("MalformedResponse", { cause })),
              ),
            ),
          )
          const signal = requestOptions.signal
          const abort = Effect.callback<never, ClientError>((resume) => {
            if (!signal) return
            const fail = () => resume(Effect.fail(new ClientError("Transport", { cause: signal.reason })))
            if (signal.aborted) return fail()
            signal.addEventListener("abort", fail, { once: true })
            return Effect.sync(() => signal.removeEventListener("abort", fail))
          })
          return {
            [Symbol.asyncIterator]() {
              const iterator = Stream.toAsyncIterable(stream.pipe(Stream.interruptWhen(abort)))[Symbol.asyncIterator]()
              return {
                next: () =>
                  iterator.next().catch((error) => {
                    throw wireError(error, codec.error)
                  }),
                return: () => iterator.return!(),
                throw: (error?: unknown) => iterator.throw!(error),
              }
            },
          }
        },
      },
    }),
    {
      dispose: () =>
        (disposal ??= (async () => {
          await client?.catch(() => {})
          await Effect.runPromise(Scope.close(scope, Exit.void))
        })()),
    },
  )
}

function wireError(error: unknown, schema: Schema.Codec<unknown, unknown>) {
  if (error instanceof ClientError) return error
  if (error instanceof RpcClientError.RpcClientError) return new ClientError("Transport", { cause: error })
  const encoded = Schema.encodeUnknownExit(schema)(error)
  return Exit.isSuccess(encoded) ? encoded.value : new ClientError("Transport", { cause: error })
}
