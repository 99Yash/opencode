export * as FileSystem from "./filesystem"

import { makeLocationNode } from "@opencode-ai/util/effect/app-node"
import path from "path"
import { Context, Effect, Layer, Schema } from "effect"
import { FSUtil } from "@opencode-ai/util/fs-util"
import { Location } from "./location"
import { PositiveInt, RelativePath } from "./schema"
import { FileSystemSearch } from "./filesystem/search"
import { Entry, FileSystem, FindInput, Match } from "@opencode-ai/schema/filesystem"
import { WorkspaceEnvironment } from "./workspace/environment"
import { Ripgrep } from "./ripgrep"
export { Entry, Match, Submatch } from "@opencode-ai/schema/filesystem"

export const ReadInput = Schema.Struct({
  path: RelativePath,
})
export type ReadInput = typeof ReadInput.Type

export const Content = Schema.Struct({
  uri: Schema.String,
  name: Schema.String.pipe(Schema.optional),
  content: Schema.String,
  encoding: Schema.Literals(["utf8", "base64"]),
  mime: Schema.String,
}).annotate({ identifier: "FileSystem.Content" })
export type Content = typeof Content.Type

export const ListInput = Schema.Struct({
  path: RelativePath.pipe(Schema.optional),
})
export type ListInput = typeof ListInput.Type

export { FindInput }

export const DEFAULT_SEARCH_LIMIT = 100
export const DEFAULT_SEARCH_TIMEOUT_MS = 30_000

export class GlobInput extends Schema.Class<GlobInput>("FileSystem.GlobInput")({
  pattern: Schema.String,
  path: Schema.optionalKey(RelativePath),
  limit: Schema.optionalKey(PositiveInt),
}) {}

export class GrepInput extends Schema.Class<GrepInput>("FileSystem.GrepInput")({
  pattern: Schema.String,
  path: Schema.optionalKey(RelativePath),
  include: Schema.optionalKey(Schema.String),
  limit: Schema.optionalKey(PositiveInt),
}) {}

export interface SearchTarget {
  readonly canonical: string
  readonly absolute: string
}

export interface GlobSearchInput {
  readonly target: SearchTarget
  readonly pattern: string
  readonly limit: number
}

export interface GrepSearchInput {
  readonly target: SearchTarget
  readonly pattern: string
  readonly include?: string
  readonly limit: number
}

export class SearchPathError extends Schema.TaggedErrorClass<SearchPathError>()("FileSystem.SearchPathError", {
  path: Schema.String,
  reason: Schema.Literals(["not_found", "not_directory"]),
}) {}

export class SearchError extends Schema.TaggedErrorClass<SearchError>()("FileSystem.SearchError", {
  cause: Schema.Defect(),
}) {}

export class InvalidPatternError extends Schema.TaggedErrorClass<InvalidPatternError>()(
  "FileSystem.InvalidPatternError",
  {
    pattern: Schema.String,
    message: Schema.String,
  },
) {}

const mapSearchError = (error: unknown) =>
  error instanceof SearchPathError || error instanceof SearchError ? error : new SearchError({ cause: error })

const mapGrepError = (error: unknown) => {
  if (error instanceof SearchPathError) return error
  if (error instanceof SearchError) return error
  if (error instanceof Ripgrep.InvalidPatternError)
    return new InvalidPatternError({ pattern: error.pattern, message: error.message })
  return new SearchError({ cause: error })
}

export const Event = FileSystem.Event

export interface Interface {
  readonly read: (input: ReadInput) => Effect.Effect<{ readonly content: Uint8Array; readonly mime: string }>
  readonly list: (input?: ListInput) => Effect.Effect<Entry[]>
  readonly find: (input: FindInput) => Effect.Effect<Entry[]>
  readonly glob: (input: GlobSearchInput) => Effect.Effect<Entry[], SearchPathError | SearchError>
  readonly grep: (input: GrepSearchInput) => Effect.Effect<Match[], SearchPathError | SearchError | InvalidPatternError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/FileSystem") {}

interface SearchPath {
  readonly resolve: (from: string, to: string) => string
  readonly relative: (from: string, to: string) => string
  readonly dirname: (value: string) => string
  readonly basename: (value: string) => string
}

const makeSearch = (
  location: Location.Interface,
  ripgrep: Ripgrep.Interface,
  paths: SearchPath,
  stat: (target: SearchTarget) => Effect.Effect<WorkspaceEnvironment.FileInfo, SearchPathError | SearchError>,
) => ({
  glob: Effect.fn("FileSystem.glob")(function* (input: GlobSearchInput) {
    if ((yield* stat(input.target)).type !== "Directory")
      return yield* new SearchPathError({ path: input.target.absolute, reason: "not_directory" })
    return yield* ripgrep
      .glob({
        cwd: input.target.canonical,
        pattern: input.pattern,
        limit: input.limit,
      })
      .pipe(
        Effect.map((entries) =>
          entries.map((entry) =>
            Entry.make({
              ...entry,
              path: RelativePath.make(
                paths.relative(location.directory, paths.resolve(input.target.absolute, entry.path)),
              ),
            }),
          ),
        ),
      )
  }, Effect.mapError(mapSearchError)),
  grep: Effect.fn("FileSystem.grep")(function* (input: GrepSearchInput) {
    const info = yield* stat(input.target)
    const file = info.type === "File"
    const cwd = file ? paths.dirname(input.target.absolute) : input.target.canonical
    const root = file ? paths.dirname(input.target.absolute) : input.target.absolute
    return yield* ripgrep
      .grep({
        cwd,
        pattern: input.pattern,
        file: file ? paths.basename(input.target.absolute) : undefined,
        include: input.include,
        limit: input.limit,
      })
      .pipe(
        Effect.map((matches) =>
          matches.map((match) =>
            Match.make({
              ...match,
              entry: Entry.make({
                ...match.entry,
                path: RelativePath.make(paths.relative(location.directory, paths.resolve(root, match.entry.path))),
              }),
            }),
          ),
        ),
      )
  }, Effect.mapError(mapGrepError)),
})

const baseLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const location = yield* Location.Service
    const search = yield* FileSystemSearch.Service
    const ripgrep = yield* Ripgrep.Service
    const searches = makeSearch(location, ripgrep, path, (target) =>
      fs.stat(target.canonical).pipe(
        Effect.catchReason("PlatformError", "NotFound", () =>
          Effect.fail(new SearchPathError({ path: target.absolute, reason: "not_found" })),
        ),
        Effect.mapError(mapSearchError),
      ),
    )
    const root = yield* fs.realPath(location.directory).pipe(Effect.orDie)
    const resolve = Effect.fnUntraced(function* (input?: RelativePath) {
      const absolute = path.resolve(location.directory, input ?? ".")
      if (!FSUtil.contains(location.directory, absolute))
        return yield* Effect.die(new Error("Path escapes the location"))
      const real = yield* fs.realPath(absolute).pipe(Effect.orDie)
      if (!FSUtil.contains(root, real)) return yield* Effect.die(new Error("Path escapes the location"))
      return { absolute, real, directory: location.directory, root }
    })
    return Service.of({
      find: search.find,
      ...searches,
      read: Effect.fn("FileSystem.read")(function* (input) {
        const target = yield* resolve(input.path)
        const info = yield* fs.stat(target.real).pipe(Effect.orDie)
        if (info.type !== "File") return yield* Effect.die(new Error("Path is not a file"))
        return {
          content: yield* fs.readFile(target.real).pipe(Effect.orDie),
          mime: FSUtil.mimeType(target.real),
        }
      }),
      list: Effect.fn("FileSystem.list")(function* (input = {}) {
        const target = yield* resolve(input.path)
        const info = yield* fs.stat(target.real).pipe(Effect.orDie)
        if (info.type !== "Directory") return yield* Effect.die(new Error("Path is not a directory"))
        return yield* fs.readDirectoryEntries(target.real).pipe(
          Effect.orDie,
          Effect.map((items) =>
            items
              .flatMap((item) => {
                if (item.type !== "file" && item.type !== "directory") return []
                const absolute = path.join(target.absolute, item.name)
                const relative = path.relative(target.directory, absolute)
                return [
                  Entry.make({
                    path: RelativePath.make(relative + (item.type === "directory" ? path.sep : "")),
                    type: item.type,
                  }),
                ]
              })
              .sort((a, b) => (a.type === b.type ? a.path.localeCompare(b.path) : a.type === "directory" ? -1 : 1)),
          ),
        )
      }),
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer: baseLayer,
  deps: [FSUtil.node, Location.node, FileSystemSearch.node, Ripgrep.node],
})

// Mirrors baseLayer over WorkspaceEnvironment.Files with posix path rules.
// Host filesystem services never see provider paths. Type mismatches surface
// from the environment operation itself; no stat pre-checks.
const hostedLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const env = yield* WorkspaceEnvironment.Service
    const location = yield* Location.Service
    const ripgrep = yield* Ripgrep.Service
    const searches = makeSearch(location, ripgrep, path.posix, (target) =>
      env.files.stat(target.canonical).pipe(
        Effect.catchTag("WorkspaceEnvironment.NotFoundError", () =>
          Effect.fail(new SearchPathError({ path: target.absolute, reason: "not_found" })),
        ),
        Effect.mapError(mapSearchError),
      ),
    )
    const root = yield* env.files.realPath(location.directory).pipe(Effect.orDie)
    const resolve = Effect.fnUntraced(function* (input?: RelativePath) {
      const absolute = path.posix.resolve(location.directory, input ?? ".")
      if (!FSUtil.containsPosix(location.directory, absolute))
        return yield* Effect.die(new Error("Path escapes the location"))
      const real = yield* env.files.realPath(absolute).pipe(Effect.orDie)
      if (!FSUtil.containsPosix(root, real)) return yield* Effect.die(new Error("Path escapes the location"))
      return { absolute, real, directory: location.directory, root }
    })
    return Service.of({
      find: () => Effect.logWarning("find is not supported for hosted locations yet").pipe(Effect.as([])),
      ...searches,
      read: Effect.fn("FileSystem.read")(function* (input) {
        const target = yield* resolve(input.path)
        return {
          content: yield* env.files.read(target.real).pipe(Effect.orDie),
          mime: FSUtil.mimeType(target.real),
        }
      }),
      list: Effect.fn("FileSystem.list")(function* (input = {}) {
        const target = yield* resolve(input.path)
        return yield* env.files.list(target.real).pipe(
          Effect.orDie,
          Effect.map((items) =>
            items
              .flatMap((item) => {
                if (item.type !== "file" && item.type !== "directory") return []
                const absolute = path.posix.join(target.absolute, item.name)
                const relative = path.posix.relative(target.directory, absolute)
                return [
                  Entry.make({
                    path: RelativePath.make(relative + (item.type === "directory" ? "/" : "")),
                    type: item.type,
                  }),
                ]
              })
              .sort((a, b) => (a.type === b.type ? a.path.localeCompare(b.path) : a.type === "directory" ? -1 : 1)),
          ),
        )
      }),
    })
  }),
)

export const hostedNode = makeLocationNode({
  service: Service,
  layer: hostedLayer,
  deps: [WorkspaceEnvironment.node, Location.node, Ripgrep.node],
})
