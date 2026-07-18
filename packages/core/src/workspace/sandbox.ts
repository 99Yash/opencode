export * as Sandbox from "./sandbox"

import { Context, Effect, Layer, Schema, Scope } from "effect"
import { makeGlobalNode } from "../effect/app-node"
import type { WorkspaceEnvironment } from "./environment"

export const Binding = Schema.Record(Schema.String, Schema.Json).annotate({ identifier: "Sandbox.Binding" })
export type Binding = typeof Binding.Type

export const Placement = Schema.Struct({
  kind: Schema.Literal("sandbox"),
  version: Schema.Literal(1),
  binding: Binding,
}).annotate({ identifier: "Sandbox.Placement" })
export type Placement = typeof Placement.Type

export class Error extends Schema.TaggedErrorClass<Error>()("Sandbox.Error", {
  provider: Schema.String,
  operation: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export interface Connection {
  readonly binding: Binding
  readonly environment: WorkspaceEnvironment.Interface
}

export interface CreateInput {
  readonly identity: string
}

export interface Provider {
  readonly key: string
  readonly create: (input: CreateInput) => Effect.Effect<Binding, Error>
  readonly decode: (binding: Binding) => Effect.Effect<Binding, Error>
  readonly connect: (binding: Binding) => Effect.Effect<Connection, Error, Scope.Scope>
  readonly suspend: (connection: Connection) => Effect.Effect<Binding, Error>
  readonly reconcile: (binding: Binding) => Effect.Effect<Binding, Error>
  readonly delete: (binding: Binding) => Effect.Effect<void, Error>
}

export class DuplicateProviderError extends Schema.TaggedErrorClass<DuplicateProviderError>()(
  "Sandbox.DuplicateProviderError",
  { provider: Schema.String },
) {}

export class ProviderNotFoundError extends Schema.TaggedErrorClass<ProviderNotFoundError>()(
  "Sandbox.ProviderNotFoundError",
  { provider: Schema.String },
) {}

export interface Registry {
  readonly register: (provider: Provider) => Effect.Effect<void, DuplicateProviderError, Scope.Scope>
  readonly get: (key: string) => Effect.Effect<Provider, ProviderNotFoundError>
}

export class RegistryService extends Context.Service<RegistryService, Registry>()("@opencode/SandboxRegistry") {}

export const registryLayer = Layer.sync(RegistryService, () => {
  const providers = new Map<string, Provider>()
  return RegistryService.of({
    register: (provider) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          if (providers.has(provider.key)) return new DuplicateProviderError({ provider: provider.key })
          providers.set(provider.key, provider)
        }).pipe(Effect.flatMap((error) => (error ? Effect.fail(error) : Effect.void))),
        () => Effect.sync(() => providers.delete(provider.key)),
      ),
    get: (key) => {
      const provider = providers.get(key)
      return provider ? Effect.succeed(provider) : Effect.fail(new ProviderNotFoundError({ provider: key }))
    },
  })
})

export const registryNode = makeGlobalNode({ service: RegistryService, layer: registryLayer, deps: [] })
