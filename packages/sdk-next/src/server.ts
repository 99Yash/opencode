import "./plugin-runtime"

import { NodeServices } from "@effect/platform-node"
import { ServerProcess } from "@opencode-ai/server/process"
import { Effect, Exit, ManagedRuntime, Scope } from "effect"
import { randomUUID } from "node:crypto"
import type { Listen, ListenOptions } from "./server-interface"

export const listen: Listen = async (options) => {
  const runtime = ManagedRuntime.make(NodeServices.layer)
  const scope = await runtime.runPromise(Scope.make())
  await runtime
    .runPromise(
      ServerProcess.start(fromEnvironment(options), {
        instanceID: randomUUID(),
        onListen: () => Effect.succeed(Effect.void),
      }).pipe(Effect.provideService(Scope.Scope, scope)),
    )
    .catch(async (error) => {
      await runtime
        .runPromise(Scope.close(scope, Exit.fail(error)))
        .finally(() => Effect.runPromise(runtime.disposeEffect))
      throw error
    })
  let stopped = false
  return {
    stop: async () => {
      if (stopped) return
      stopped = true
      await runtime.runPromise(Scope.close(scope, Exit.void)).finally(() => Effect.runPromise(runtime.disposeEffect))
    },
  }
}

function fromEnvironment(options: ListenOptions, environment = process.env) {
  const channel = options.app.channel
  return {
    ...options,
    simulation: truthy(environment.OPENCODE_SIMULATE),
    database: {
      path:
        environment.OPENCODE_DB ??
        (["latest", "beta", "prod"].includes(channel) || truthy(environment.OPENCODE_DISABLE_CHANNEL_DB)
          ? "opencode.db"
          : `opencode-${channel.replace(/[^a-zA-Z0-9._-]/g, "-")}.db`),
    },
    models: {
      url: environment.OPENCODE_MODELS_URL,
      file: environment.OPENCODE_MODELS_PATH,
      fetch: !truthy(environment.OPENCODE_DISABLE_MODELS_FETCH),
    },
    observability: {
      endpoint: environment.OTEL_EXPORTER_OTLP_ENDPOINT,
      headers: environment.OTEL_EXPORTER_OTLP_HEADERS,
    },
    config: {
      directory: environment.OPENCODE_CONFIG_DIR,
      project: !truthy(environment.OPENCODE_CONFIG_PROJECT_DISABLE ?? environment.OPENCODE_DISABLE_PROJECT_CONFIG),
      file: environment.OPENCODE_CONFIG,
      content: environment.OPENCODE_CONFIG_CONTENT,
    },
    windows: {
      gitbash: environment.OPENCODE_GIT_BASH_PATH,
    },
    fs: {
      filewatcher: !truthy(environment.OPENCODE_FILEWATCHER_DISABLE ?? environment.OPENCODE_DISABLE_FILEWATCHER),
      fff:
        environment.OPENCODE_DISABLE_FFF === undefined
          ? process.platform !== "win32"
          : !truthy(environment.OPENCODE_DISABLE_FFF),
    },
  }
}

function truthy(value?: string) {
  return value === "1" || value?.toLowerCase() === "true"
}

export const Server = { listen }
