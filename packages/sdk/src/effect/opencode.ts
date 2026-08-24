export * as OpenCode from "./opencode"

import { OpenCode, type OpenCodeClient } from "@opencode-ai/client/effect"
import type { Workspace } from "@opencode-ai/core/workspace"
import { Context, Effect, Layer } from "effect"
import type { Config, Scope } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { EmbeddedHost } from "../internal/host"

export type { LogEntry, LogLevel, LogOptions, LogWriter } from "../logging"

export type CreateOptions = EmbeddedHost.CreateOptions
export type EmbedOptions = EmbeddedHost.EmbedOptions

export type Interface = Omit<OpenCodeClient, "plugin" | "workspace"> & {
  readonly sessions: OpenCodeClient["session"]
  readonly events: OpenCodeClient["event"]
  readonly workspace: {
    readonly create: (options: { readonly provider: string }) => ReturnType<Workspace.Interface["create"]>
    readonly provision: (options: {
      readonly workspaceID: Workspace.ID
    }) => ReturnType<Workspace.Interface["provision"]>
    readonly destroy: (options: { readonly workspaceID: Workspace.ID }) => ReturnType<Workspace.Interface["destroy"]>
  }
  readonly plugin: EmbeddedHost.Interface["plugins"]["register"] & OpenCodeClient["plugin"]
}

const starts = new WeakMap<Interface, Effect.Effect<void>>()

const make: (
  options?: CreateOptions,
  embed?: EmbedOptions,
) => Effect.Effect<Interface, Config.ConfigError | Error, Scope.Scope> = Effect.fn("OpenCode.make")(function* (
  options: CreateOptions = {},
  embed: EmbedOptions = {},
) {
  const host = yield* Effect.acquireRelease(EmbeddedHost.create(options, embed), (host) => Effect.promise(host.close))
  const client = yield* OpenCode.make({ baseUrl: "http://opencode.local" }).pipe(
    Effect.provide(
      FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, host.fetch)), Layer.fresh),
    ),
  )

  const opencode: Interface = {
    ...client,
    sessions: client.session,
    events: client.event,
    workspace: {
      create: ({ provider }: { readonly provider: string }) => host.workspace.create(provider),
      provision: ({ workspaceID }: { readonly workspaceID: Workspace.ID }) => host.workspace.provision(workspaceID),
      destroy: ({ workspaceID }: { readonly workspaceID: Workspace.ID }) => host.workspace.destroy(workspaceID),
    },
    plugin: Object.assign(host.plugins.register, client.plugin),
  }
  starts.set(opencode, host.start)
  return opencode
})

export const create: (
  options?: CreateOptions,
  embed?: EmbedOptions,
) => Effect.Effect<Interface, Config.ConfigError | Error, Scope.Scope> = Effect.fn("OpenCode.create")(function* (
  options: CreateOptions = {},
  embed: EmbedOptions = {},
) {
  const opencode = yield* make(options, embed)
  yield* recovery(opencode)
  return opencode
})

export class Service extends Context.Service<Service, Interface>()("@opencode-ai/sdk/OpenCode") {}

export const layer = (
  options: CreateOptions = {},
  embed: EmbedOptions = {},
): Layer.Layer<Service, Config.ConfigError | Error> => Layer.effect(Service, create(options, embed))

/** Builds a host whose recovery is deferred until `OpenCode.start`. */
export const layerDeferred = (
  options: CreateOptions = {},
  embed: EmbedOptions = {},
): Layer.Layer<Service, Config.ConfigError | Error> => Layer.effect(Service, make(options, embed))

/** Starts suspended-session recovery after the complete application layer has built. */
export const start = <A, E, R>(self: Layer.Layer<Service | A, E, R>): Layer.Layer<Service | A, E, R> =>
  self.pipe(Layer.tap((services: Context.Context<Service>) => recovery(Context.get(services, Service))))

function recovery(opencode: Interface) {
  return starts.get(opencode) ?? Effect.die(new Error("OpenCode.start requires OpenCode.layerDeferred"))
}
