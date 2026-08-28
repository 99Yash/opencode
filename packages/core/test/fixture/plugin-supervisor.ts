import { PluginSupervisor } from "@opencode-ai/core/plugin/supervisor-service"
import { Effect } from "effect"

export const noopPluginSupervisor = (flush: Effect.Effect<unknown> = Effect.void) =>
  PluginSupervisor.Service.of({
    flush: Effect.asVoid(flush),
    initialized: Effect.asVoid(flush),
    check: () => Effect.die("unused plugin.check"),
    update: () => Effect.die("unused plugin.update"),
    reload: () => Effect.die("unused plugin.reload"),
  })
