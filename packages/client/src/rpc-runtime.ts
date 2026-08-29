export * as RpcRuntime from "./rpc-runtime.js"

import type { Rpc } from "@opencode-ai/schema/rpc"
import type { OpenCodeEvent } from "@opencode-ai/protocol/groups/event"
import { RpcError } from "@opencode-ai/protocol/errors"
import { Effect, Schema } from "effect"

type RpcEvent = Extract<OpenCodeEvent, { type: `rpc.${string}` }>

export function read(schema: Rpc.Method["output"], value: unknown) {
  // Standard Schema results have already been parsed by the server.
  return Schema.isSchema(schema) ? Schema.decodeUnknownEffect(schema)(value) : Effect.succeed(value)
}

export function readError(method: Rpc.Method, error: unknown): Effect.Effect<never, unknown> {
  if (!(error instanceof RpcError)) return Effect.fail(error)
  if (!method.errors || !Object.hasOwn(method.errors, error.type)) {
    return Effect.fail(
      error.data === undefined
        ? { type: error.type, message: error.message }
        : { type: error.type, message: error.message, data: error.data },
    )
  }
  return read(method.errors[error.type], error.data).pipe(
    Effect.catch((cause) => Effect.die(cause)),
    Effect.flatMap((data) =>
      Effect.fail(
        data === undefined
          ? { type: error.type, message: error.message }
          : { type: error.type, message: error.message, data },
      ),
    ),
  )
}

export const event = Effect.fn("Client.Rpc.event")(function* <
  D extends Rpc.Definition,
  Name extends keyof D["events"] & string,
>(definition: D, name: Name, event: RpcEvent): Effect.fn.Return<Rpc.EventPayload<D, Name>, unknown> {
  const schema = definition.events[name]
  if (!schema) return yield* Effect.fail(new Error(`Unknown RPC event: ${definition.namespace}.${name}`))
  if (event.type !== eventType(definition, name))
    return yield* Effect.fail(new Error(`Unexpected RPC event type: ${event.type}`))
  const data = yield* read(schema.schema, event.data)
  if (!schema.durable) {
    if (event.durable) return yield* Effect.fail(new Error(`Expected ephemeral RPC event: ${event.type}`))
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- event envelope and definition durability are checked above.
    return {
      ...event,
      type: eventType(definition, name),
      data,
      location: { ...event.location },
    } as Rpc.EventPayload<D, Name>
  }
  if (!event.durable) return yield* Effect.fail(new Error(`Expected durable RPC event: ${event.type}`))
  if (event.durable.version !== schema.durable.version)
    return yield* Effect.fail(
      new Error(
        `RPC event version mismatch for ${definition.namespace}.${name}: expected ${schema.durable.version}, got ${event.durable.version}`,
      ),
    )
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- event envelope, version, and definition are checked above.
  return {
    ...event,
    type: eventType(definition, name),
    data,
    location: { ...event.location },
  } as Rpc.EventPayload<D, Name>
})

export function eventType<const D extends Rpc.Definition, const Name extends keyof D["events"] & string>(
  definition: D,
  name: Name,
): `rpc.${D["namespace"]}.${Name}` {
  return `rpc.${definition.namespace}.${name}`
}
