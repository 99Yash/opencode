import type { Instance } from "@opencode-ai/core/instance"
import { Location } from "@opencode-ai/core/location"
import { LocationServiceMap } from "@opencode-ai/core/location-service-map"
import type { LocationServices } from "@opencode-ai/core/location-services"
import { Project } from "@opencode-ai/core/project"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Effect, Layer, LayerMap } from "effect"
import { tmpdir } from "./tmpdir"

/**
 * A LocationServiceMap whose every instance resolves to the given services.
 * Unit fixtures provide only the services their test exercises, so the
 * narrowing assertion each caller used to repeat lives here once.
 */
export function stubLocations<A, E, R>(services: Layer.Layer<A, E, R>) {
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  const layer = services as unknown as Layer.Layer<LocationServices>
  return Layer.effect(
    LocationServiceMap.Service,
    Effect.map(
      LayerMap.make((_: Instance.Key) => layer),
      LocationServiceMap.fromKeyed,
    ),
  )
}

export function location(ref: Location.Ref, input: { projectDirectory?: AbsolutePath; vcs?: Project.Vcs } = {}) {
  const directory = input.projectDirectory ?? ref.directory
  return {
    directory: ref.directory,
    workspaceID: ref.workspaceID,
    project: { id: Project.ID.global, directory, canonical: directory },
    vcs: input.vcs,
  } satisfies Location.Interface
}

export const tempLocationLayer = Layer.unwrap(
  Effect.acquireRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  ).pipe(
    Effect.map((tmp) => {
      const ref = Location.Ref.make({ directory: AbsolutePath.make(tmp.path) })
      return Layer.succeed(Location.Service, Location.Service.of(location(ref)))
    }),
  ),
)
