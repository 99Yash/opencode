import path from "path"
import { Context, Effect, Layer, LayerMap, RcMap } from "effect"
import { LayerNode } from "@opencode-ai/util/effect/layer-node"
import { Node } from "@opencode-ai/util/effect/app-node"
import { Location } from "./location.js"
import { AbsolutePath } from "./schema.js"
import type { LocationError, LocationServices } from "./location-services.js"

export class Service extends Context.Service<
  Service,
  LayerMap.LayerMap<Location.Ref, LocationServices, LocationError>
>()("@opencode/example/LocationServiceMap") {
  static get(ref: Location.Ref) {
    return Layer.unwrap(Effect.map(Service, (locations) => locations.get(ref)))
  }
}

export const node = LayerNode.unbound(Service, Node.tags.values.global)

// RcMap keys distinguish optional-property shape and Windows path separators.
export const canonical = (ref: Location.Ref) =>
  Location.Ref.make({
    directory: AbsolutePath.make(process.platform === "win32" ? path.normalize(ref.directory) : ref.directory),
    workspaceID: ref.workspaceID,
  })

export const has = (locations: LayerMap.LayerMap<Location.Ref, LocationServices, LocationError>, ref: Location.Ref) =>
  RcMap.has(locations.rcMap, canonical(ref))

export * as LocationServiceMap from "./location-service-map.js"
