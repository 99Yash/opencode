import { Event } from "@opencode-ai/schema/event"
import { RelativePath } from "@opencode-ai/core/schema"
import { Context, Effect, Layer, Scope, Stream } from "effect"
import { Headers, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiGroup, HttpApiEndpoint } from "effect/unstable/httpapi"
import { Rpc, RpcGroup, RpcSchema, RpcSerialization, RpcServer } from "effect/unstable/rpc"
import { OpenCodeRpc } from "@opencode-ai/protocol/rpc"
import { Api } from "./api"
import { ServerAuth } from "./auth"
import { CorsConfig, isAllowedRequestOrigin } from "./cors"
import { EventFeed } from "./event-feed"
import type { handlers } from "./handlers"
import { readFile } from "./handlers/fs"
import { LocationMiddleware } from "./location"
import { Authorization, authorizedRequest } from "./middleware/authorization"
import { FormLocationMiddleware } from "./middleware/form-location"
import { SessionLocationMiddleware } from "./middleware/session-location"
import { SchemaErrorMiddleware } from "./middleware/schema-error"

type Services =
  | Layer.Success<typeof handlers>
  | ServerAuth.Config
  | EventFeed.Service
  | LocationMiddleware
  | FormLocationMiddleware
  | SessionLocationMiddleware
  | Authorization
  | SchemaErrorMiddleware

type Input = {
  readonly params?: Readonly<Record<string, string>>
  readonly query?: { readonly location?: { readonly directory?: string; readonly workspace?: string } }
  readonly payload?: unknown
  readonly headers?: Readonly<Record<string, string | undefined>>
  readonly location?: { readonly directory?: string; readonly workspace?: string }
}

type Middleware = (
  effect: Effect.Effect<unknown, unknown, unknown>,
  options: { readonly group: HttpApiGroup.Top; readonly endpoint: HttpApiEndpoint.Top },
) => Effect.Effect<unknown, unknown, unknown>

type Handler = {
  readonly endpoint: HttpApiEndpoint.Top
  readonly uninterruptible: boolean
  readonly handler: (
    input: Input & {
      readonly request: HttpServerRequest.HttpServerRequest
      readonly group: HttpApiGroup.Top
      readonly endpoint: HttpApiEndpoint.Top
    },
  ) => Effect.Effect<unknown, unknown, unknown>
}

export const rpcRoutes = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const services = yield* Effect.context<Services>()
    const config = yield* ServerAuth.Config
    const feed = yield* EventFeed.Service
    const group = OpenCodeRpc.makeGroup(Api)
    // HttpApiBuilder stores its decoded handlers beside the built routes. Keep this
    // dependency on Effect's handler registry here, rather than duplicating handlers
    // or routing RPC calls through HTTP serialization and parsing.
    const entries = (Object.values(Api.groups) as unknown as ReadonlyArray<HttpApiGroup.Top>).flatMap((definition) => {
      const implementation = services.mapUnsafe.get(definition.key) as {
        readonly handlers: ReadonlyMap<string, Handler>
      }
      return Array.from(implementation.handlers.values(), (handler) => ({ definition, ...handler }))
    })
    yield* router.add(
      "GET",
      "/api/rpc",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        if (!(yield* authorizedRequest(request, config)))
          return HttpServerResponse.empty({
            status: 401,
            headers: { "www-authenticate": 'Basic realm="Secure Area"' },
          })
        const cors = yield* CorsConfig
        if (!isAllowedRequestOrigin(request.headers.origin, request.headers.host, cors))
          return HttpServerResponse.empty({ status: 403 })

        // Handler resources belong to an RPC request, not the WebSocket upgrade.
        const context = Context.merge(services, yield* Effect.context<never>()).pipe(Context.omit(Scope.Scope))
        const implementations = Object.fromEntries(
          entries.flatMap((entry) => {
            const rpc = group.requests.get(entry.endpoint.identifier)
            if (!rpc) return []
            const streaming = RpcSchema.isStreamSchema(rpc.successSchema)
            const invoke = (input: Input, options: { readonly headers: Headers.Headers }) => {
              const url = new URL(request.url, "http://localhost")
              url.pathname = entry.endpoint.path
              const location = input.location ?? input.query?.location
              if (location) {
                if (location.directory) url.searchParams.set("location[directory]", location.directory)
                if (location.workspace) url.searchParams.set("location[workspace]", location.workspace)
                else url.searchParams.delete("location[workspace]")
              }
              // RPC metadata carries contextual headers (global forms and PTY tickets);
              // the authenticated upgrade remains authoritative for its own headers.
              const headers = Headers.merge(
                Headers.merge(Headers.fromInput(input.headers), options.headers),
                request.headers,
              )
              const current = request.modify({
                url: `${url.pathname}${url.search}`,
                headers: location ? Headers.remove(headers, "x-opencode-workspace") : headers,
              })
              const run = Effect.gen(function* () {
                if (rpc._tag === "event.subscribe") {
                  const live = yield* feed.subscribeEvents
                  return Stream.make({ id: Event.ID.create(), type: "server.connected" as const, data: {} }).pipe(
                    Stream.concat(live),
                    Stream.orDie,
                  )
                }
                if (rpc._tag === "fs.read") return yield* readFile(RelativePath.make(input.params?.path ?? ""))
                const result = yield* entry.handler({
                  ...input,
                  request: current,
                  group: entry.definition,
                  endpoint: entry.endpoint,
                })
                // Streams are consumed after middleware returns; retain the location
                // services selected for this call, not the connection's last location.
                if (Stream.isStream(result)) return Stream.provideContext(result, yield* Effect.context<never>())
                return result
              }) as Effect.Effect<unknown, unknown, unknown>
              const wrapped = Array.from(entry.endpoint.middlewares).reduce((effect, key) => {
                // Authentication belongs to the upgrade, not client-supplied frame headers.
                if (key.key === Authorization.key) return effect
                const middleware = Context.getUnsafe(context, key) as Middleware
                if (typeof middleware !== "function") throw new Error(`Unsupported RPC middleware: ${key.key}`)
                return middleware(effect, { group: entry.definition, endpoint: entry.endpoint })
              }, run)
              const effect = (entry.uninterruptible ? Effect.uninterruptible(wrapped) : wrapped).pipe(
                Effect.provideService(HttpServerRequest.HttpServerRequest, current),
                Effect.provideService(HttpRouter.RouteContext, {
                  params: input.params ?? {},
                  route: HttpRouter.route(
                    entry.endpoint.method,
                    entry.endpoint.path as HttpRouter.PathInput,
                    HttpServerResponse.empty(),
                  ),
                }),
                Effect.provideContext(context as Context.Context<unknown>),
              )
              return streaming
                ? Stream.unwrap(effect as Effect.Effect<Stream.Stream<unknown, unknown>, unknown>)
                : effect
            }
            return [[rpc._tag, invoke]]
          }),
        )
        const runtime = group as unknown as RpcGroup.RpcGroup<Rpc.Any>
        const implementation = yield* runtime.toHandlers(implementations as unknown as RpcGroup.HandlersFrom<Rpc.Any>)
        const websocket = yield* RpcServer.toHttpEffectWebsocket(runtime, { disableFatalDefects: true }).pipe(
          Effect.provideContext(implementation),
          Effect.provide(RpcSerialization.layerJson),
        )
        return yield* websocket
      }),
    )
  }),
)
