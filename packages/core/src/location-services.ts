import { Duration, Effect, Layer, LayerMap } from "effect"
import { existsSync } from "fs"
import { LayerNode } from "@opencode-ai/util/effect/layer-node"
import { Instance } from "./instance.js"
import { Location } from "./location.js"
import { LocationServiceMap } from "./location-service-map.js"

export { LocationServiceMap } from "./location-service-map.js"

export type LocationServices = Instance.Services
export type LocationError = Instance.Error

export function buildLocationServiceMap(
  replacements: LayerNode.Replacements = [],
): Layer.Layer<LocationServiceMap.Service> {
  return Layer.effect(
    LocationServiceMap.Service,
    Effect.map(
      LayerMap.make((key: Instance.Key) => Instance.layer(Location.parseInstanceKey(key), { replacements }), {
        // Workspace-placed directories exist only inside the workspace, so a
        // local stat consults the wrong filesystem. Workspace liveness is
        // owned by placement; do not probe the sandbox here, which would
        // provision lazily-idle workspaces.
        idleTimeToLive: (key) => {
          const ref = Location.parseInstanceKey(key)
          return ref.workspaceID !== undefined || existsSync(ref.directory) ? Duration.infinity : Duration.zero
        },
      }),
      LocationServiceMap.fromKeyed,
    ),
  )
}
