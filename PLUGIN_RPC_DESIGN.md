# Plugin RPC and Custom Events

Design notes and implementation record. Shared definitions, the location-scoped
Core registry, local Promise/Effect plugin APIs, HTTP dispatch, external typed
clients, shared event connections, and Bus publication are implemented.
Plugin log/replay APIs and per-namespace OpenAPI discovery are intentionally deferred.

## First Slice

- `@opencode-ai/schema/rpc` owns the execution-neutral `Rpc.define` contract; `@opencode-ai/plugin/rpc` re-exports the canonical namespace.
- Promise and Effect client API types describe typed subclients, while plugin domain types add registration and event publishing.
- Portable Standard Schema and JSON Schema definitions work with both client and plugin styles. Effect Schema definitions are accepted only by Effect consumers.
- Compile-time fixtures check inference and rejected inputs, outputs, names, payloads, and location overrides through public exports.
- `bun typecheck` in `packages/plugin` includes the inference fixtures; runtime tests verify contract identity and a browser-safe definition entrypoint with no Effect runtime dependency.

The method name `events` is reserved for the subclient's event API. It cannot
also be declared as an RPC method.

## Second Slice

- `packages/core/src/rpc.ts` owns the location-scoped `Rpc.Service`, with scoped registration stacks, per-call active lookup, and direct dispatch.
- `Rpc.call(namespace, method, input)` validates wire input and returns wire output; typed local subclients apply the corresponding result schema decoding without an HTTP request.
- Both plugin contexts expose `ctx.rpc(definition)` and `ctx.rpc.register(definition, handlers)`. Promise adaptation forwards cancellation and supplies `context.signal` to handlers.
- Local custom events publish through the existing bus with captured location and typed subscriptions. Location objects at public event boundaries do not alias private routing state.
- Promise subscriptions close independently on unsubscribe, abort, or plugin unload. Effect subscriptions use normal Stream scope cleanup.
- Core tests cover actual registrations, overrides, scope disposal, schemas/transforms, JSON boundaries, cancellation, location isolation, and plugin activation in both API styles.

## Transport and Client Slice

- Public Promise and Effect `OpenCode.make` factories expose callable `client.rpc(definition)`, retaining `client.rpc.call` for generic wire calls.
- One `POST /api/rpc/:namespace/:method` handler routes through existing location and authentication middleware. Input/output wrappers support primitives and omitted values.
- The HTTP boundary awaits the existing plugin activation barrier so cold locations are ready. Core and `ctx.rpc` lookup do not wait for registrations or reload implementations.
- Custom events use direct `rpc.<namespace>.<event>` envelopes with required location. Native and typed RPC subscriptions observe the same event; typed subclients apply the declared payload schema.
- One lazy shared source per base client fans out native and RPC events, caches connection metadata only, bounds each subscriber queue, and closes on the last subscriber leaving.
- Promise RPC stays runtime-independent from Effect and accepts only portable definitions. Effect clients decode Effect codecs normally.
- Native and RPC Promise plugin subscriptions share scoped iterator cleanup and respect subscriber-local signals.
- Public protocol/client/OpenAPI artifacts are regenerated; plugin/client guides document the feature.

Intended usage passes one concrete RPC definition. Conditional definition
unions and numeric event names are not part of the supported usage being designed.

## Goals

- Let server plugins expose RPC methods callable by any OpenCode client or other server plugins.
- Let plugins define and publish custom events that consumers can subscribe to.
- Infer types for method arguments, results, handlers, and event payloads from a shared contract.
- Support both Promise and Effect execution without forcing plugin authors to use Effect.

Custom events are ephemeral and use normal Bus publication.

## Shared Definition

`Rpc.define(...)` is a plain, synchronous, execution-neutral contract builder.
It defines an RPC namespace, method input/output schemas, and event payload
schemas. It contains no handlers and does not register or execute the plugin.

RPC namespaces are independent of plugin IDs. One plugin can register multiple
namespaces, and another plugin can override one using the same definition. The
namespace determines RPC routing and event prefixes; the plugin ID determines
registration ownership and cleanup. Do not add an automatic plugin-ID prefix.

Each method declares `input` and `output`, plus an optional `errors` map. The
output schema checks handler return types, validates results at runtime, and
determines the caller's inferred result type. Error map keys become the error
`type`; each value validates and transforms that error's `data`.

Publish the definition in a browser-safe module such as `acme-plugin/rpc`.
Clients and other plugins can import it without importing server implementation
code or running plugin setup.

The complete definition format accepts the existing `Tool.ValueSchema` options:

- Effect Schema, with TypeScript inference, for Effect clients and plugins only.
- Standard Schema, including Zod, with TypeScript inference.
- Plain JSON Schema, without automatic TypeScript inference.

Promise clients and plugins accept Standard Schema or plain JSON Schema. Effect
clients and plugins accept all three. Use a portable Standard or JSON Schema
definition when the same contract must be consumed through both API styles.

```ts
// acme-plugin/rpc
import { Rpc } from "@opencode-ai/plugin/rpc"
import { z } from "zod"

export const Acme = Rpc.define({
  namespace: "acme",
  methods: {
    search: {
      input: z.object({ query: z.string() }),
      output: z.object({ text: z.string() }),
      errors: {
        not_found: z.object({ query: z.string() }),
      },
    },
  },
  events: {
    updated: {
      schema: z.object({ itemID: z.string(), text: z.string() }),
    },
    progress: {
      schema: z.object({ percent: z.number() }),
    },
  },
})
```

## Event Definitions

Define events inline as a map within `Rpc.define(...)`, not an array. No
separate event builder or explicit `type` field is required. Each map key is a
local event name; the public event type is automatically prefixed with the namespace:
`rpc.${namespace}.${eventName}`. The example defines `rpc.acme.updated` and `rpc.acme.progress`.

Each event definition has a `schema` accepting `Tool.ValueSchema`. Publishing
uses the normal ephemeral Bus path.

Custom event data must be an object. Effect and Standard Schema definitions
enforce that in their inferred types; plain JSON Schema is checked when emitting.
Scalars, arrays, `null`, and `undefined` are not valid event payloads.

Publishing supplies only the payload. Subscribers receive the standard event
envelope with `id`, `created`, `type`, `data`, required `location`, optional
`metadata`.
OpenCode supplies the emitting plugin instance's location; publishers do not
provide or override it.

The subclient uses local event names for subscriptions and publishing, with
inferred payload and envelope types. Consumers import only the RPC
definition, not individual event definitions.

External subclients receive the namespace's events across all server locations,
not just the default location or a location used by an RPC call. Consumers can
filter using the required `event.location` field. Server plugin subscriptions
are bound to the calling plugin instance's location.

Live subscriptions do not replay missed events. Events emitted while a consumer
is disconnected are missed; there is no plugin log API in this design yet.

## Client API

The factory belongs to the OpenCode client, not the RPC definition:

```ts
import { Acme } from "acme-plugin/rpc"

const acme = client.rpc(Acme)
const result = await acme.search({ query: "hello" })

const unsubscribe = acme.events.on("updated", (event) => {
  console.log(event.type, event.data.text) // type: "rpc.acme.updated"
  console.log(event.location.directory) // Emitting plugin instance's location
})
```

The subclient exposes only the namespace's methods and events. It reuses the
supplied OpenCode client's connection, authentication, and transport.
Creating a subclient does not load the server plugin.

Other server plugins use the same calling shape: `ctx.rpc(Acme)`.
Whether calls return Promises or Effects is determined by the supplied client
or context, not by how the RPC handlers are implemented.

Calling and implementing are independent capabilities. A server plugin can
obtain a consumer handle without implementing the namespace, implement a namespace,
or do both. `ctx.rpc(Acme)` provides the consumer API;
`ctx.rpc.register(Acme, handlers)` registers the implementation.

### Handle Lifecycle

`client.rpc(Acme)` and `ctx.rpc(Acme)` return a handle immediately, even if no
implementation is registered yet. Creating a handle does not wait for namespace
availability.

Each method call resolves the currently active registration at its target
location. Handles do not cache implementations, reload, or track registration
changes; each call simply looks up the active implementation. A call already
running finishes against the implementation it started with, rather than
switching handlers mid-call.
If no implementation is available when called, fail immediately instead of
waiting for a registration. The HTTP boundary waits for normal plugin activation
at the requested location before this lookup; it does not wait for a particular
namespace to appear. Direct plugin calls do not use that barrier, avoiding setup
recursion.

## Location and Call Options

RPC namespaces are implemented at the registering server plugin instance's location.
Select an external call's location through a second optional options argument,
not through subclient construction or the method's declared input:

```ts
const acme = client.rpc(Acme)

await acme.search({ query: "hello" })
await acme.search({ query: "hello" }, { location: { directory: "/path/to/project" } })
```

External call options can include `location`, `signal`, and `headers`. When
location is omitted, use the existing request defaults: explicit location
headers, if present, then the server's working directory. The base OpenCode
client has no dedicated configured location; it has connection and header options.

Server plugin consumer handles are bound to the calling plugin instance's
location and do not expose a location override:

```ts
const acme = ctx.rpc(Acme)
await acme.search({ query: "hello" })
```

Both consumers use the same RPC definition and inferred method input/output
types. Routing metadata is separate from the payload and never injected into
handler arguments. Do not reserve a top-level `location` input field or require
object-shaped inputs just to support routing. This intentionally differs from
native endpoints such as `skill.list`, which put optional location inside the
first input argument.

The same location rules apply to Promise and Effect RPC calls. Event subscriptions
are different: external clients receive namespace events from all locations, while
server plugin handles receive only events from their own location. Per-call RPC
location options do not change a subclient's subscriptions.

## RPC Transport

Use one generic HTTP handler with a distinct URL for each namespace method:

```text
POST /api/rpc/acme/search
POST /api/rpc/acme/refresh
```

The handler dispatches by RPC namespace, method name, and resolved request location.
Plugins register dynamically; they do not need separate handler implementations
or generated OpenCode clients for each method.

Registration supplies the RPC definition and handlers to the server at each
location. The dispatcher resolves them dynamically; it does not require the
server to separately import a well-known RPC export from each plugin package.

The request body is `{ input?: unknown }` and the success body is `{ output?: unknown }`.
Omitted fields represent no value. Location uses the existing native deep-object
query/header resolution; call metadata is not part of the method input.
The endpoint uses standard HTTP error wrappers around generic
`{ type, message, data? }` RPC failures. Declared and request failures use
`RpcError` at 400; unexpected defects use `RpcInternalError` at 500. Typed
clients remove those transport wrappers and decode declared error data through
the selected method's error map. Validation and lookup failures retain reserved
`rpc.*` types. Interruption is not converted to a method failure.

## Deferred OpenAPI Integration

Do not add individual plugin RPC methods to the server's OpenAPI document yet.
The initial implementation uses the imported shared definition for typed clients
and the runtime registration for dispatch and validation.

The generic dispatch operation and dynamic `rpc.${string}` event envelope are
part of the native API contract and generated OpenAPI document, not a dynamic
per-namespace inventory.

Registration is per location, so discovering contracts for a server-wide spec
or a location-specific spec requires further design. Revisit that separately,
including whether packages need a well-known declaration export. Do not add
declaration discovery or dynamic per-namespace OpenAPI generation now.

Existing tool JSON Schema conversion may help with future OpenAPI integration,
but Standard Schema validation alone does not guarantee JSON Schema conversion.
OpenAPI representability is not an initial RPC requirement.

## Event Subscription APIs

Both subclient versions expose `events.subscribe(name)` as the primitive,
matching the native clients' event subscription representations:

- Promise: a typed `AsyncIterable`.
- Effect: a typed `Stream`.

```ts
// Promise client
for await (const event of acme.events.subscribe("updated")) {
  console.log(event.data.text)
}
```

Promise subclients also expose `events.on(name, handler)` as a convenience
wrapper over the same subscription primitive, returning an unsubscribe function:

```ts
const unsubscribe = acme.events.on("updated", (event) => {
  console.log(event.data.text)
})
```

Effect subclients keep the Stream API without a callback convenience wrapper:

```ts
const updates = acme.events.subscribe("updated")
```

The local event name selects its exact envelope and payload type. Effect
subscriptions compose with normal Stream operators. Ending async iteration,
stopping Stream consumption, or calling the Promise convenience unsubscribe
function removes only that subscriber. Constructing an iterable or Stream alone
does not open a connection; `on` starts consuming for the listener.

`on` and `subscribe` share the same event source. The convenience wrapper does
not create a separate HTTP connection.

These APIs apply to both external and server plugin subclients, preserving their
different location rules. External subscriptions share the base client's event
connection; plugin subscriptions use the internal bus. Unsubscribing or stopping
one consumer does not stop other consumers.

## Custom Event Transport

Reuse the existing `/api/event` stream for custom RPC events alongside native
events. Do not add a separate event endpoint per namespace.

The native stream carries the actual `rpc.<namespace>.<event>` type and direct
JSON object payload. Reserving the `rpc.` prefix keeps dynamic events disjoint
from native event literals, preserving native union narrowing.

The subclient's `subscribe` API and Promise `on` wrapper match namespace and local
name, then apply the declared payload schema. External
clients receive matching namespace events across all locations. Server plugin RPC
subscriptions stay bound to their own location. The shared definition supplies
the payload schema and inferred types. Live delivery has no implicit replay.

### Shared Connection Lifecycle

The base OpenCode client owns one lazy, shared event connection. Creating a
client or RPC handle opens no event connection. The first active event subscriber
opens it; native and RPC subscribers share it through local fan-out. When the
last subscriber leaves, close the connection. Sharing is per base client instance,
not process-global or per RPC namespace.

Handwritten public client facades wrap the generated raw event transport with
this shared source. Server plugin subscriptions use the internal bus directly
and do not open HTTP event connections.

Cache only the latest `server.connected` marker for late subscribers,
so native connection consumers still receive their initial handshake. Do not
replay business events. A replacement connection may open while the previous
source finishes cleanup.

The shared source advances after every active subscriber accepts the current
event. Consumers that perform slow work should drain and buffer events themselves.
Source EOF/failure ends current subscriptions, without automatic retry. Consumers
resubscribe after recovery.
Promise `on` logs callback/source failures and ends its listener.
Callbacks may be async: each listener awaits its callback before processing the
next event, so rejected callbacks are caught and only that listener ends.

Native event subscriptions have no payload, location, or filter arguments. The
Effect client exposes `subscribe()`; the Promise client may accept an optional `signal`
for subscriber-local cancellation. Cancelling one subscriber removes only that
subscriber and does not disconnect others; close the shared connection only if
no subscribers remain.

Use the base client's headers for the shared event connection. Remove existing
Promise subscription-level header overrides rather than opening separate
connections for listeners with different headers.

## Server Registration

Register handlers during plugin initialization, with access to the plugin context:

```ts
import { Plugin } from "@opencode-ai/plugin"
import { Acme } from "acme-plugin/rpc"

export default Plugin.define({
  id: "acme",
  async setup(ctx) {
    const registration = await ctx.rpc.register(Acme, {
      search: async ({ query }) => ({ text: query }),
    })

    await registration.events.emit("updated", {
      itemID: "123",
      text: "hello",
    })
  },
})
```

The handler map implements every declared method. The returned registration
handle provides typed event publishing. Registration belongs to the plugin
instance and is automatically removed when that instance unloads.

For the same namespace at the same location, the latest active registration
wins, matching custom tool registration behavior. It replaces the effective
namespace implementation as a whole, rather than merging individual handlers.
Removing or unloading a registration removes only that registration and reveals
the previous active implementation, if any. Registrations at different locations
do not override one another.

Provide both execution APIs, matching existing plugins:

- Promise plugins register inside `setup`, use `await`, and supply Promise handlers.
- Effect plugins register inside the existing `effect` initializer, use `yield*`, and supply Effect handlers.
- Event publishing likewise returns a Promise or Effect according to the registration API.

## Call Cancellation

Handlers receive a general second call-context argument. Its typed `error`
constructor builds declared failures. Promise contexts also contain `signal`:

```ts
search: async ({ query }, context) => {
  const result = await fetchResults(query, { signal: context.signal })
  if (!result) return context.error("not_found", "Result not found", { query })
  return result
}
```

Promise handlers may either return or throw a value made by `context.error`.
Effect handlers use the native error channel:

```ts
search: ({ query }, context) =>
  findResult(query).pipe(
    Effect.flatMap((result) =>
      result
        ? Effect.succeed(result)
        : Effect.fail(context.error("not_found", "Result not found", { query })),
    ),
  )
```

Cancelling an external request signals the Promise handler to stop. Cancellation
is cooperative: the handler must observe the signal or pass it to cancellable
operations. Effect handlers use normal Effect interruption instead.

Changing the active registration does not cancel already-running calls. They
continue against their original implementation unless the call itself is cancelled.

## Type Safety

### Local and Remote Contract Boundaries

Server-plugin calls dispatch directly to the active implementation without an
HTTP request. Both local and external dispatch apply the declared input and output
schemas. Local dispatch does not simulate JSON serialization; the actual HTTP
client owns transport serialization for external calls.

Plain JSON Schema is interpreted as Draft 2020-12 and delegated directly to
Effect's JSON Schema importer and decoder. RPC adds no dialect compatibility or
keyword policy.

Schema parsers own validation and transformation. RPC does not invent conversion
rules; it applies the schema at the contract boundary and derives the corresponding
caller and handler types. For input schemas, the caller supplies the accepted
input representation and the handler receives the parsed value. Parse input at
dispatch rather than transforming it on the client and parsing it again on the
server. Local calls follow the same rule.

Effect codecs own their encoded representation. Standard and plain JSON schemas
are responsible for returning values appropriate for their eventual transport.
Event schemas require an object encoded/output type. RPC applies the schema and
passes that object directly to Bus publication.

### Inference and Validation

- Preserve literal namespace, method, and event names in `Rpc.define(...)`.
- Infer handler argument types and check handler return values against their schemas.
- Check caller arguments and infer RPC results and declared errors.
- Check published event payloads and infer subscriber payload types.
- Infer fully prefixed event types from the namespace and local map keys, while exposing local names to callers.
- Reject unknown method and event names at compile time.
- Validate data crossing the network at runtime, rather than relying only on TypeScript.

Plain JSON Schema remains supported but does not provide the same automatic
TypeScript inference. Schema transforms need explicit treatment of wire input
and decoded output types; execution neutrality must not erase those distinctions.

## Existing References

- `packages/schema/src/tool.ts`: `Tool.ValueSchema` and schema-based inference.
- `packages/schema/src/event.ts`: internal event definitions and ephemeral envelopes.
- `packages/core/src/bus.ts`: publication and live subscriptions.
- `packages/core/src/tool/runtime.ts`: schema validation and input/output JSON Schema conversion.
- `packages/plugin/src/promise/tool.ts`: Promise tool handlers.
- `packages/plugin/src/effect/tool.ts`: Effect tool registrations.
- `packages/plugin/src/promise/plugin.ts`: Promise plugin `setup` and context.
- `packages/plugin/src/effect/plugin.ts`: Effect plugin initializer and context.
- `packages/client/src/promise/generated/client.ts`: base client options, request options, and native `skill.list` calling convention.
- `packages/server/src/location.ts`: per-request location resolution from query, headers, and server working directory.
- `packages/server/src/routes.ts`: current static OpenAPI generation through `HttpApiBuilder.layer`.
- `packages/protocol/src/groups/event.ts`: current public SSE event contract, which is volatile and uses a static event union.
- `packages/server/src/event-feed.ts`: current public event filtering and subscriber lifecycle.

Implementation should preserve package dependency boundaries. Effect plugin
domains extend the corresponding Effect client API and add only plugin-specific
capabilities, such as registration. Public protocol changes require client
generation rather than manual edits to generated clients.
