import { LocationServiceMap } from "@opencode-ai/core/location-service-map"
import type { LocationServices } from "@opencode-ai/core/location-services"
import { PluginHooks } from "@opencode-ai/core/plugin/hooks"
import { PluginSupervisor } from "@opencode-ai/core/plugin/supervisor-service"
import { PluginExecution } from "@opencode-ai/core/plugin/execution"
import { noopPluginSupervisor } from "./plugin-supervisor"
import { LayerNode } from "@opencode-ai/util/effect/layer-node"
import { Layer, LayerMap } from "effect"

// Plain-prompt unit fixtures use virtual directories and need only the admission hook services.
export const promptLocationLayer = Layer.effect(
  LocationServiceMap.Service,
  LayerMap.make(
    () =>
      Layer.mergeAll(
        LayerNode.compile(PluginHooks.node),
        PluginExecution.layer,
        Layer.succeed(PluginSupervisor.Service, noopPluginSupervisor()),
      ) as Layer.Layer<LocationServices>,
  ),
)
