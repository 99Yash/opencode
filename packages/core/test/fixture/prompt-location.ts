import { LocationServiceMap } from "@opencode-ai/core/location-service-map"
import type { LocationServices } from "@opencode-ai/core/location-services"
import { PluginHooks } from "@opencode-ai/core/plugin/hooks"
import { PluginSupervisor } from "@opencode-ai/core/plugin/supervisor-service"
import { Reference } from "@opencode-ai/core/reference"
import { LayerNode } from "@opencode-ai/util/effect/layer-node"
import { Effect, Layer, LayerMap } from "effect"

// Plain-prompt unit fixtures use virtual directories without configured references.
export const promptLocationLayer = Layer.effect(
  LocationServiceMap.Service,
  LayerMap.make(
    () =>
      Layer.mergeAll(
        LayerNode.compile(PluginHooks.node),
        Layer.succeed(PluginSupervisor.Service, { flush: Effect.void }),
        Layer.mock(Reference.Service, { refresh: () => Effect.void }),
      ) as Layer.Layer<LocationServices>,
  ),
)
