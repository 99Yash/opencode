export * as Client from "./client"

import { Context, Layer } from "effect"
import { makeGlobalNode } from "./effect/app-node"

export const Name = Context.Reference<string>("@opencode/Client/Name", {
  defaultValue: () => "cli",
})

export const layer = (name = "cli") => Layer.succeed(Name, name)

export const configured = (name?: string) => makeGlobalNode({ service: Name, layer: layer(name), deps: [] })

export const node = configured()
