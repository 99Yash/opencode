import { Context, Effect, Layer, LayerMap, RcMap, Scope } from "effect"
import { LayerNode } from "@opencode-ai/util/effect/layer-node"
import { Node } from "@opencode-ai/util/effect/app-node"
import { Location } from "./location.js"
import type { Instance } from "./instance.js"

export interface Interface {
  /** Placement lookup: services for an explicitly requested location. */
  readonly get: (ref: Location.Ref) => Layer.Layer<Instance.Services, Instance.Error>
  readonly contextEffect: (
    ref: Location.Ref,
  ) => Effect.Effect<Context.Context<Instance.Services>, Instance.Error, Scope.Scope>
  readonly invalidate: (ref: Location.Ref) => Effect.Effect<void>
  /** Assignment lookup: services for the instance the Session belongs to. */
  readonly forSession: (session: {
    readonly location: Location.Ref
  }) => Layer.Layer<Instance.Services, Instance.Error>
  /** The string-keyed store; keys are minted by the assignment policy. */
  readonly rcMap: RcMap.RcMap<Instance.Key, Context.Context<Instance.Services>, Instance.Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/example/LocationServiceMap") {
  static get(ref: Location.Ref) {
    return Layer.unwrap(Effect.map(Service, (locations) => locations.get(ref)))
  }
}

/**
 * Adapts a string-keyed instance map to the Service interface. Every location
 * lookup mints its key, so minting is the canonicalization boundary: separator
 * style and optional-field shape cannot split cache entries.
 */
export function fromKeyed(keyed: LayerMap.LayerMap<Instance.Key, Instance.Services, Instance.Error>): Interface {
  return {
    get: (ref) => keyed.get(Location.instanceKey(ref)),
    contextEffect: (ref) => keyed.contextEffect(Location.instanceKey(ref)),
    invalidate: (ref) => keyed.invalidate(Location.instanceKey(ref)),
    forSession: (session) => keyed.get(Location.instanceKey(session.location)),
    rcMap: keyed.rcMap,
  }
}

export const node = LayerNode.unbound(Service, Node.tags.values.global)

export * as LocationServiceMap from "./location-service-map.js"
