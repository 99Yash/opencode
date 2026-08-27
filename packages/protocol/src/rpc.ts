export * as OpenCodeRpc from "./rpc.js"

import { Predicate, Schema, SchemaAST, Stream } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware, HttpApiSchema } from "effect/unstable/httpapi"
import { Rpc, RpcGroup, RpcSchema } from "effect/unstable/rpc"
import { ClientApi } from "./client.js"
import { LocationQuery } from "./groups/location.js"

export const omitEndpoints: ReadonlySet<string> = new Set(["pty.connect", "persistentPty.connect"])

export const FileRead = Schema.Struct({ content: Schema.Uint8ArrayFromBase64, mime: Schema.String })
export const FileReadParams = Schema.Struct({ path: Schema.String })

type Part<K extends string, S extends Schema.Constraint> = [S] extends [never] ? {} : { readonly [P in K]: S["Type"] }

export type Request<E extends HttpApiEndpoint.ConstraintRequest> = (E["identifier"] extends "fs.read"
  ? { readonly params: typeof FileReadParams.Type }
  : Part<"params", E["~Params"]>) &
  Part<"query", E["~Query"]> &
  Part<"payload", E["~Payload"]> &
  Part<"headers", E["~Headers"]> & {
    readonly location?: typeof LocationQuery.Type.location
  }

type Success<S extends Schema.Constraint> =
  S["Type"] extends Stream.Stream<infer A, infer E>
    ? RpcSchema.Stream<Schema.Codec<A, unknown>, Schema.Codec<E, unknown>>
    : Schema.Codec<S["Type"], unknown>

export type Endpoint<E extends HttpApiEndpoint.ConstraintRequest> = E extends HttpApiEndpoint.ConstraintRequest
  ? E["identifier"] extends "pty.connect" | "persistentPty.connect"
    ? never
    : Rpc.Rpc<
        E["identifier"],
        Schema.Codec<Request<E>, unknown>,
        E["identifier"] extends "fs.read" ? typeof FileRead : Success<E["~Success"]>,
        Schema.Codec<E["~Error"]["Type"] | HttpApiMiddleware.Error<E["~Middleware"]>, unknown>
      >
  : never

type Endpoints<G extends HttpApiGroup.Constraint> =
  HttpApiGroup.Endpoints<G> extends infer E
    ? E extends HttpApiEndpoint.ConstraintRequest
      ? Endpoint<E>
      : never
    : never

/** Convert HTTP stream declarations to RPC streams without serializing an SSE envelope. */
export function successSchema(schema: Schema.Top): Schema.Top {
  if (RpcSchema.isStreamSchema(schema)) return schema
  if (!isHttpStream(schema)) return Schema.toCodecJson(schema)
  if (schema._tag === "StreamUint8Array") {
    return RpcSchema.Stream(Schema.Uint8ArrayFromBase64, Schema.Unknown)
  }
  if (schema.sseMode === "events") {
    return RpcSchema.Stream(Schema.toCodecJson(schema.events), Schema.toCodecJson(schema.error))
  }
  // StreamSse({ data }) stores its original data codec in the event struct's data field.
  const ast = SchemaAST.toType(schema.events.ast)
  const data = SchemaAST.isObjects(ast) ? ast.propertySignatures.find((field) => field.name === "data") : undefined
  if (!data) throw new Error("SSE data schema is missing its data field")
  return RpcSchema.Stream(Schema.toCodecJson(Schema.make(data.type)), Schema.toCodecJson(schema.error))
}

function isHttpStream(schema: Schema.Top): schema is HttpApiSchema.StreamSchema {
  return Predicate.hasProperty(schema, "~effect/httpapi/HttpApiSchema/Stream")
}

export function fromEndpoint<E extends HttpApiEndpoint.ConstraintRequest>(input: E): Endpoint<E> {
  const endpoint = input as unknown as HttpApiEndpoint.Top
  if (omitEndpoints.has(endpoint.identifier)) throw new Error(`Raw WebSocket endpoint: ${endpoint.identifier}`)
  const payload = Array.from(endpoint.payload.values()).flatMap((entry) => entry.schemas)
  const success = endpoint.success.size ? Array.from(endpoint.success) : [HttpApiSchema.NoContent]
  const middleware = Array.from(endpoint.middlewares) as unknown as HttpApiMiddleware.AnyService[]
  const errors = [...endpoint.error, ...middleware.flatMap((service) => Array.from(service.error))]
  if (success.length > 1 && success.some(isHttpStream)) {
    throw new Error(`Mixed streaming responses are not supported: ${endpoint.identifier}`)
  }
  const request = Schema.Struct({
    ...(endpoint.identifier === "fs.read"
      ? { params: FileReadParams }
      : endpoint.params
        ? { params: Schema.toCodecJson(Schema.toType(endpoint.params)) }
        : {}),
    ...(endpoint.query ? { query: Schema.toCodecJson(Schema.toType(endpoint.query)) } : {}),
    ...(endpoint.headers ? { headers: Schema.toCodecJson(Schema.toType(endpoint.headers)) } : {}),
    ...(payload.length ? { payload: Schema.toCodecJson(Schema.toType(Schema.Union(payload))) } : {}),
    location: LocationQuery.fields.location,
  })
  return Rpc.make(endpoint.identifier, {
    payload: request,
    success:
      endpoint.identifier === "fs.read"
        ? FileRead
        : success.length === 1
          ? successSchema(success[0]!)
          : Schema.Union(success.map(successSchema)),
    error: Schema.toCodecJson(Schema.Union([...new Set(errors)])),
  }) as unknown as Endpoint<E>
}

/** Server passes its concrete HttpApi so its middleware error schemas are retained. */
export function makeGroup<Id extends string, G extends HttpApiGroup.Constraint>(
  api: HttpApi.HttpApi<Id, G>,
): RpcGroup.RpcGroup<Endpoints<G>> {
  const groups = Object.values((api as unknown as HttpApi.Top).groups)
  return RpcGroup.make(
    ...groups.flatMap((group) =>
      Object.values(group.endpoints)
        .filter((endpoint) => !omitEndpoints.has(endpoint.identifier))
        .map(fromEndpoint),
    ),
  ) as unknown as RpcGroup.RpcGroup<Endpoints<G>>
}

export type Rpcs = Endpoints<(typeof ClientApi.groups)[keyof typeof ClientApi.groups]>
export const Group: RpcGroup.RpcGroup<Rpcs> = makeGroup(ClientApi)
