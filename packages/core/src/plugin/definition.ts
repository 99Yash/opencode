import type { Context as PluginContext, Plugin as PluginDefinition } from "@opencode-ai/plugin/effect/plugin"
import type { Scope } from "effect"

export type Context = PluginContext
export type Plugin<R = Scope.Scope> = PluginDefinition<R>

export function define<R>(plugin: PluginDefinition<R>) {
  return plugin
}

export namespace Plugin {
  export type Context = PluginContext
  export type Plugin<R = Scope.Scope> = PluginDefinition<R>
  export const define = <R>(plugin: PluginDefinition<R>) => plugin
}
