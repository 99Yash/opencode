export * as OpenCodeWorkerd from "./workerd"

import { Layer } from "effect"
import type { Config, Scope } from "effect"
import { WorkerdProfile } from "../internal/workerd"
import { OpenCode } from "./opencode"

export { Service } from "./opencode"

export type Configuration = WorkerdProfile.Configuration

export interface CreateOptions extends WorkerdProfile.Options {
  readonly log?: OpenCode.CreateOptions["log"]
  readonly workspaceProviders?: OpenCode.CreateOptions["workspaceProviders"]
}

export const create = (options: CreateOptions) => {
  const host = make(options)
  return OpenCode.create(host.options, host.embed)
}

export const layer = (options: CreateOptions): Layer.Layer<OpenCode.Service, Config.ConfigError | Error> => {
  const host = make(options)
  return OpenCode.layer(host.options, host.embed)
}

export const layerDeferred = (options: CreateOptions): Layer.Layer<OpenCode.Service, Config.ConfigError | Error> => {
  const host = make(options)
  return OpenCode.layerDeferred(host.options, host.embed)
}

export const start = OpenCode.start

export type Interface = OpenCode.Interface
export type Requirements = Scope.Scope

function make({ log, workspaceProviders, ...options }: CreateOptions) {
  const profile = WorkerdProfile.make(options)
  return {
    options: { ...profile.options, log, workspaceProviders },
    embed: { overrides: profile.replacements },
  }
}
