export * as McpCodeModePlugin from "./mcp-codemode.js"

import { define } from "@opencode-ai/plugin/effect/plugin"
import { ConfigMCP } from "@opencode-ai/schema/config/mcp"
import { makeLocationNode } from "@opencode-ai/util/effect/app-node"
import { Context, Effect, Layer, Scope } from "effect"

const directToolHosts = new Set(["mcp.cloudflare.com"])
type Resolver = (config: typeof ConfigMCP.Server.Type) => boolean | undefined

export interface Interface {
  register: (resolver: Resolver) => Effect.Effect<void, never, Scope.Scope>
  resolve: (config: typeof ConfigMCP.Server.Type) => boolean | undefined
}

export class Service extends Context.Service<Service, Interface>()("@opencode/McpCodeModePlugin") {}

export const layer = Layer.effect(
  Service,
  Effect.sync(() => {
    let resolvers: Resolver[] = []
    return Service.of({
      register: Effect.fn("McpCodeModePlugin.register")(function* (resolver) {
        resolvers = [...resolvers, resolver]
        yield* Effect.addFinalizer(() => Effect.sync(() => (resolvers = resolvers.filter((item) => item !== resolver))))
      }),
      resolve: (config) =>
        resolvers
          .toReversed()
          .map((resolver) => resolver(config))
          .find((value) => value !== undefined),
    })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [] })

export const Plugin = define({
  id: "opencode.mcp.codemode-compatibility",
  effect: Effect.fn(function* () {
    const defaults = yield* Service
    yield* defaults.register(codeModeCompatibilityDefault)
  }),
})

export function codeModeCompatibilityDefault(config: typeof ConfigMCP.Server.Type) {
  if (config.type !== "remote") return
  const url = URL.parse(config.url)
  if (!url || !directToolHosts.has(url.hostname.toLowerCase())) return
  return false
}
