import { Context, Effect, Layer } from "effect"
import path from "path"
import { Info, Ref, response } from "@opencode-ai/schema/location"
import { Instance } from "@opencode-ai/schema/instance"
import { AbsolutePath } from "@opencode-ai/schema/schema"
import { WorkspaceID } from "@opencode-ai/schema/workspace-id"
import { Project } from "./project.js"
import { LayerNode } from "@opencode-ai/util/effect/layer-node"
import { makeLocationNode, tags } from "@opencode-ai/util/effect/app-node"

export * as Location from "./location.js"

export { Info, Ref, response }

/**
 * The built-in assignment policy: sessions placed at the same canonical
 * location share one instance. Minting canonicalizes, so key equality is the
 * only comparison the instance map ever needs.
 */
export function instanceKey(ref: Ref): Instance.Key {
  const directory = process.platform === "win32" ? path.normalize(ref.directory) : ref.directory
  return Instance.Key.make(ref.workspaceID ? `location:${ref.workspaceID}:${directory}` : `location:${directory}`)
}

/** Inverts {@link instanceKey}. Keys not minted by the location policy are a defect. */
export function parseInstanceKey(key: Instance.Key): Ref {
  if (!key.startsWith("location:")) throw new Error(`Unknown instance key: ${key}`)
  const rest = key.slice("location:".length)
  // Workspace IDs are `wrk`-prefixed and colon-free; absolute paths never start with `wrk`.
  if (!rest.startsWith("wrk")) return Ref.make({ directory: AbsolutePath.make(rest) })
  const separator = rest.indexOf(":")
  if (separator === -1) throw new Error(`Unknown instance key: ${key}`)
  return Ref.make({
    directory: AbsolutePath.make(rest.slice(separator + 1)),
    workspaceID: WorkspaceID.make(rest.slice(0, separator)),
  })
}

export interface Interface extends Info {
  readonly vcs?: Project.Vcs
  readonly vcsBackend?: string
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Location") {}

export const node = LayerNode.unbound(Service, tags.values.location)

const layer = (ref: Ref, options?: { readonly discovery?: boolean }) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const project = yield* Project.Service
      const resolved = yield* project.resolve(ref.directory, options)
      return Service.of({
        directory: ref.directory,
        workspaceID: ref.workspaceID,
        project: { id: resolved.id, directory: resolved.directory, canonical: resolved.canonical },
        vcs: resolved.vcs,
        vcsBackend: resolved.vcsBackend,
      })
    }),
  )

export const boundNode = (ref: Ref, options?: { readonly discovery?: boolean }) =>
  makeLocationNode({
    service: Service,
    layer: layer(ref, options),
    deps: [Project.node],
  })
