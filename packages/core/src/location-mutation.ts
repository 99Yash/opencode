export * as LocationMutation from "./location-mutation"

import { makeLocationNode } from "@opencode-ai/util/effect/app-node"
import path from "path"
import { Context, Effect, Layer, Schema } from "effect"
import { FSUtil } from "@opencode-ai/util/fs-util"
import { Location } from "./location"
import { Project } from "./project"
import { AbsolutePath } from "./schema"
import { WorkspaceEnvironment } from "./workspace/environment"

export const Kind = Schema.Literals(["file", "directory"])
export type Kind = typeof Kind.Type

/**
 * Mutation paths do not accept project references. Relative paths resolve
 * from the active Location. Paths outside it require separate
 * `external_directory` approval.
 */
export const ResolveInput = Schema.Struct({
  path: Schema.String,
  /** Selects the external approval boundary; it does not validate the target type. */
  kind: Kind.pipe(Schema.optional),
})
export type ResolveInput = typeof ResolveInput.Type

export class PathError extends Schema.TaggedErrorClass<PathError>()("LocationMutation.PathError", {
  path: Schema.String,
  reason: Schema.Literals(["non_directory_ancestor", "outside_workspace"]),
}) {}

export interface ExternalDirectoryAuthorization {
  readonly action: "external_directory"
  /** Canonical existing directory used as the external approval boundary. */
  readonly directory: string
  /** `external_directory` permission resource. */
  readonly resource: string
  readonly save: string
}

export const externalDirectoryPermission = (input: ExternalDirectoryAuthorization) => ({
  action: input.action,
  resources: [input.resource],
  save: [input.save],
})

export interface Target {
  /** Canonical existing path, or missing path below a canonical directory. */
  readonly canonical: string
  /** Permission resource: Location-relative for internal paths, canonical for external paths. */
  readonly resource: string
  readonly externalDirectory?: ExternalDirectoryAuthorization
}

export interface Interface {
  /**
   * Resolve a path and derive its permission resources. Relative paths resolve
   * from the Location. Paths outside it require separate `external_directory`
   * approval. This does not approve the mutation.
   */
  readonly resolve: (input: ResolveInput) => Effect.Effect<Target, PathError | FSUtil.Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/LocationMutation") {}

interface ResolvedPath {
  readonly canonical: string
  readonly type?:
    | "File"
    | "Directory"
    | "SymbolicLink"
    | "BlockDevice"
    | "CharacterDevice"
    | "FIFO"
    | "Socket"
    | "Unknown"
  readonly directory: string
}

const slash = (value: string) => value.replaceAll("\\", "/")

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const location = yield* Location.Service

    function notFound<A>(effect: Effect.Effect<A, FSUtil.Error>) {
      return effect.pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(undefined)))
    }

    const resolvePath = Effect.fnUntraced(function* (absolute: string) {
      const existing = yield* notFound(fs.realPath(absolute))
      if (existing !== undefined) {
        const info = yield* fs.stat(existing)
        return {
          canonical: existing,
          type: info.type,
          directory: info.type === "Directory" ? existing : path.dirname(existing),
        } satisfies ResolvedPath
      }

      let anchor = path.dirname(absolute)
      while (true) {
        const canonical = yield* notFound(fs.realPath(anchor))
        if (canonical !== undefined) {
          const info = yield* fs.stat(canonical)
          if (info.type !== "Directory") {
            return yield* new PathError({ path: absolute, reason: "non_directory_ancestor" })
          }
          return {
            canonical: path.resolve(canonical, path.relative(anchor, absolute)),
            directory: canonical,
          } satisfies ResolvedPath
        }
        const parent = path.dirname(anchor)
        if (parent === anchor) return yield* new PathError({ path: absolute, reason: "non_directory_ancestor" })
        anchor = parent
      }
    })

    const resolve = Effect.fn("LocationMutation.resolve")(function* (input: ResolveInput) {
      const absolute = path.resolve(location.directory, input.path)
      // External access follows the requested path boundary. Symlinks reached through an
      // internal path intentionally retain internal permission semantics after canonicalization.
      const lexicallyInternal = FSUtil.contains(location.directory, absolute)

      const resolved = yield* resolvePath(absolute)
      const external = !lexicallyInternal
      const resource = external ? slash(resolved.canonical) : slash(path.relative(location.directory, absolute) || ".")
      const externalDirectory =
        input.kind === "directory" && resolved.type === "Directory" ? resolved.canonical : resolved.directory
      const externalResource = slash(path.join(externalDirectory, "*"))
      return {
        canonical: resolved.canonical,
        resource,
        externalDirectory: external
          ? {
              action: "external_directory",
              directory: externalDirectory,
              resource: externalResource,
              save: slash(
                path.join((yield* Project.root(fs, AbsolutePath.make(externalDirectory))) ?? externalDirectory, "*"),
              ),
            }
          : undefined,
      } satisfies Target
    })

    return Service.of({ resolve })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer: layer.pipe(Layer.orDie),
  deps: [FSUtil.node, Location.node],
})

// Mirrors the local resolve walk over WorkspaceEnvironment.Files with posix
// rules. Hosted paths are never external: everything outside the Location is
// rejected instead of routed to external_directory approval, because the
// approval boundary vocabulary is host-relative.
const hostedLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const env = yield* WorkspaceEnvironment.Service
    const location = yield* Location.Service

    function notFound<A>(effect: Effect.Effect<A, WorkspaceEnvironment.Error | WorkspaceEnvironment.NotFoundError>) {
      return effect.pipe(
        Effect.catchTag("WorkspaceEnvironment.NotFoundError", () => Effect.succeed(undefined)),
        Effect.orDie,
      )
    }

    const resolvePath = Effect.fnUntraced(function* (absolute: string) {
      const existing = yield* notFound(env.files.realPath(absolute))
      if (existing !== undefined) {
        const info = yield* notFound(env.files.stat(existing))
        if (info === undefined) return yield* new PathError({ path: absolute, reason: "non_directory_ancestor" })
        return {
          canonical: existing,
          type: info.type,
          directory: info.type === "Directory" ? existing : path.posix.dirname(existing),
        } satisfies ResolvedPath
      }

      let anchor = path.posix.dirname(absolute)
      while (true) {
        const canonical = yield* notFound(env.files.realPath(anchor))
        if (canonical !== undefined) {
          const info = yield* notFound(env.files.stat(canonical))
          if (info === undefined || info.type !== "Directory") {
            return yield* new PathError({ path: absolute, reason: "non_directory_ancestor" })
          }
          return {
            canonical: path.posix.resolve(canonical, path.posix.relative(anchor, absolute)),
            directory: canonical,
          } satisfies ResolvedPath
        }
        const parent = path.posix.dirname(anchor)
        if (parent === anchor) return yield* new PathError({ path: absolute, reason: "non_directory_ancestor" })
        anchor = parent
      }
    })

    const resolve = Effect.fn("LocationMutation.resolve")(function* (input: ResolveInput) {
      const absolute = path.posix.resolve(location.directory, input.path)
      const relative = path.posix.relative(location.directory, absolute)
      if (relative.startsWith("..") || path.posix.isAbsolute(relative))
        return yield* new PathError({ path: absolute, reason: "outside_workspace" })
      const resolved = yield* resolvePath(absolute)
      return {
        canonical: resolved.canonical,
        resource: relative || ".",
      } satisfies Target
    })

    return Service.of({ resolve })
  }),
)

export const hostedNode = makeLocationNode({
  service: Service,
  layer: hostedLayer.pipe(Layer.orDie),
  deps: [WorkspaceEnvironment.node, Location.node],
})
