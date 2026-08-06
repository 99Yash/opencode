import { Context, Effect, Layer } from "effect"
import { Info, Ref, response } from "@opencode-ai/schema/location"
import { AbsolutePath } from "@opencode-ai/schema/schema"
import { Project } from "./project"
import { Workspace } from "./workspace"
import { LayerNode } from "@opencode-ai/util/effect/layer-node"
import { makeLocationNode, tags } from "@opencode-ai/util/effect/app-node"

export * as Location from "./location"

export { Info, Ref, response }

export interface Interface extends Info {
  readonly vcs?: Project.Vcs
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Location") {}

export const node = LayerNode.unbound(Service, tags.values.location)

const layer = (ref: Ref) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const project = yield* Project.Service
      const resolved = yield* project.resolve(ref.directory)
      return Service.of({
        directory: ref.directory,
        workspaceID: ref.workspaceID,
        project: { id: resolved.id, directory: resolved.directory, canonical: resolved.canonical },
        vcs: resolved.vcs,
      })
    }),
  )

export const boundNode = (ref: Ref) =>
  makeLocationNode({
    service: Service,
    layer: layer(ref),
    deps: [Project.node],
  })

/**
 * Hosted Locations state their Project instead of discovering it: host git
 * and filesystem walks must never run against a provider directory. Project
 * identity stays global until rediscovery inside the Workspace stamps a real
 * one.
 */
export const hostedBoundNode = (ref: Ref, workspaceID: Workspace.ID) =>
  makeLocationNode({
    service: Service,
    layer: Layer.effect(
      Service,
      Effect.gen(function* () {
        const workspaces = yield* Workspace.Service
        const workspace = yield* workspaces.get(workspaceID)
        return Service.of({
          directory: ref.directory,
          workspaceID,
          // Canonical "/" matches the local non-VCS fallback shape.
          project: {
            id: Project.ID.global,
            directory: AbsolutePath.make(workspace.root),
            canonical: AbsolutePath.make("/"),
          },
        })
      }),
    ),
    deps: [Workspace.node],
  })
