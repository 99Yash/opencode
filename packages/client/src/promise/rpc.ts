import type { Rpc } from "@opencode-ai/schema/rpc"
import type { make, RequestOptions } from "./generated/client.js"
import { isRpcError } from "./generated/types.js"
import type { EventSubscribeOutput, LocationGetInput, RpcCallInput } from "./generated/types.js"

type RpcEvent = Extract<EventSubscribeOutput, { type: `rpc.${string}` }>

export interface RpcCallOptions extends RequestOptions {
  readonly location?: LocationGetInput["location"]
}

export type RpcArguments<Input, Options> = unknown extends Input
  ? [input: Input, options?: Options]
  : undefined extends Input
    ? [input?: Input, options?: Options]
    : [input: Input, options?: Options]

export type RpcClient<D extends Rpc.PortableDefinition, Options = RpcCallOptions> = {
  readonly [Name in keyof D["methods"]]: (
    ...args: RpcArguments<Rpc.Input<D["methods"][Name]["input"]>, Options>
  ) => Promise<Rpc.Output<D["methods"][Name]["output"]>>
} & {
  readonly events: {
    readonly subscribe: <Name extends keyof D["events"] & string>(
      name: Name,
      options?: Pick<RequestOptions, "signal">,
    ) => AsyncIterable<RpcEventPayload<D, Name>>
    readonly on: <Name extends keyof D["events"] & string>(
      name: Name,
      handler: (event: RpcEventPayload<D, Name>) => Promise<void> | void,
      options?: Pick<RequestOptions, "signal">,
    ) => () => void
  }
}

type RpcEventPayloadFor<
  D extends Rpc.PortableDefinition,
  Name extends keyof D["events"] & string,
  E extends Rpc.PortableEventDefinition = D["events"][Name],
> = E extends Rpc.DurableEventDefinition
  ? Omit<RpcEvent, "type" | "data" | "durable"> & {
      type: `rpc.${D["namespace"]}.${Name}`
      data: Rpc.EventData<E["schema"]>
      durable: { aggregateID: string; seq: number; version: number }
    }
  : Omit<RpcEvent, "type" | "data" | "durable"> & {
      durable?: never
      type: `rpc.${D["namespace"]}.${Name}`
      data: Rpc.EventData<E["schema"]>
    }

export type RpcEventPayload<
  D extends Rpc.PortableDefinition,
  Name extends keyof D["events"] & string = keyof D["events"] & string,
> = { [K in Name]: RpcEventPayloadFor<D, K> }[Name]

export interface RpcApi<Options = RpcCallOptions> {
  <D extends Rpc.PortableDefinition>(definition: D): RpcClient<D, Options>
}

export function makeRpc(
  raw: ReturnType<typeof make>,
  events: { subscribe(options?: Pick<RequestOptions, "signal">): AsyncIterable<EventSubscribeOutput> },
): RpcApi {
  return (definition) => {
    const subscribe = (
      name: string,
      options?: Pick<RequestOptions, "signal">,
    ): AsyncIterable<RpcEventPayload<Rpc.PortableDefinition>> => {
      if (!Object.hasOwn(definition.events, name)) throw new Error(`Unknown RPC event: ${definition.namespace}.${name}`)
      const type = eventType(definition, name)
      return {
        [Symbol.asyncIterator]() {
          const controller = new AbortController()
          const signal = options?.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal
          const iterator = (async function* () {
            try {
              for await (const published of events.subscribe({ signal })) {
                if (signal.aborted) return
                if (!isRpcEvent(published) || published.type !== type) continue
                if (!signal.aborted) yield event(definition, name, published)
              }
            } catch (error) {
              if (!signal.aborted) throw error
            } finally {
              controller.abort()
            }
          })()
          return {
            next: () => iterator.next(),
            return: () => {
              // Interrupt a pending source read before closing the generator.
              controller.abort()
              return iterator.return()
            },
          }
        },
      }
    }
    // Runtime keys are built directly from the checked definition's mapped public type.
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- runtime keys come from the checked definition.
    return Object.assign(
      Object.fromEntries(
        Object.keys(definition.methods).map((name) => [
          name,
          async (input: unknown, options?: RpcCallOptions) => {
            try {
              const result = await raw.rpc.call(
                {
                  namespace: definition.namespace,
                  method: name,
                  // The generated transport owns JSON serialization; RPC adds no preflight parser.
                  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
                  input: input as RpcCallInput["input"],
                  location: options?.location,
                },
                { signal: options?.signal, headers: options?.headers },
              )
              return result.output
            } catch (error) {
              if (!isRpcError(error)) throw error
              throw error.data === undefined
                ? { type: error.type, message: error.message }
                : { type: error.type, message: error.message, data: error.data }
            }
          },
        ]),
      ),
      {
        events: {
          subscribe,
          on: (
            name: string,
            handler: (event: RpcEventPayload<Rpc.PortableDefinition>) => Promise<void> | void,
            options?: Pick<RequestOptions, "signal">,
          ) => {
            const controller = new AbortController()
            const signal = options?.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal
            const source = subscribe(name, { signal })
            void (async () => {
              for await (const event of source) await handler(event)
            })().catch((error: unknown) => console.error(error))
            return () => controller.abort()
          },
        },
      },
    ) as RpcClient<typeof definition>
  }
}

function event(
  definition: Rpc.PortableDefinition,
  name: string,
  event: RpcEvent,
): RpcEventPayload<Rpc.PortableDefinition> {
  const schema = definition.events[name]
  if (!schema) throw new Error(`Unknown RPC event: ${definition.namespace}.${name}`)
  if (!schema.durable) {
    if (event.durable) throw new Error(`Expected ephemeral RPC event: ${eventType(definition, name)}`)
    return {
      ...event,
      type: eventType(definition, name),
      location: { ...event.location },
    }
  }
  if (!event.durable) throw new Error(`Expected durable RPC event: ${eventType(definition, name)}`)
  if (event.durable.version !== schema.durable.version)
    throw new Error(
      `RPC event version mismatch for ${definition.namespace}.${name}: expected ${schema.durable.version}, got ${event.durable.version}`,
    )
  return {
    ...event,
    type: eventType(definition, name),
    location: { ...event.location },
  }
}

function isRpcEvent(event: EventSubscribeOutput): event is RpcEvent {
  return event.type.startsWith("rpc.")
}

function eventType(definition: Rpc.PortableDefinition, name: string) {
  return `rpc.${definition.namespace}.${name}` as const
}
