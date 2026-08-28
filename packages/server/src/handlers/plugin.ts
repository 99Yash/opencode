import { Plugin } from "@opencode-ai/core/plugin"
import { PluginSupervisor } from "@opencode-ai/core/plugin/supervisor"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { response } from "../location"

export const PluginHandler = HttpApiBuilder.group(Api, "server.plugin", (handlers) =>
  handlers
    .handle("plugin.list", () =>
      Effect.gen(function* () {
        return yield* response(Plugin.Service.use((plugin) => plugin.list()))
      }),
    )
    .handle("plugin.check", ({ payload }) =>
      response(PluginSupervisor.Service.use((plugins) => plugins.check(payload.target))),
    )
    .handle("plugin.update", ({ payload }) =>
      response(PluginSupervisor.Service.use((plugins) => plugins.update(payload.target))),
    )
    .handle("plugin.reload", ({ payload }) =>
      response(PluginSupervisor.Service.use((plugins) => plugins.reload(payload.target))),
    ),
)
