import { PluginSupervisor } from "@opencode-ai/core/plugin/supervisor"
import { ServiceUnavailableError } from "@opencode-ai/protocol/errors"
import { Effect } from "effect"

export function pluginReadiness(error: () => ServiceUnavailableError) {
  return PluginSupervisor.Service.pipe(
    // Reads may keep observing the coherent active graph while replacement waits for running tools.
    Effect.flatMap((plugins) => plugins.initialized),
    Effect.timeoutOrElse({
      duration: "5 seconds",
      orElse: () => Effect.fail(error()),
    }),
  )
}
