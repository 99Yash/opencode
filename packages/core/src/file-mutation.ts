export * as FileMutation from "./file-mutation"

import { makeLocationNode } from "@opencode-ai/util/effect/app-node"
import { Context, Effect, Layer, Schema } from "effect"
import { KeyedMutex } from "./effect/keyed-mutex"
import { FSUtil } from "@opencode-ai/util/fs-util"
import { Bom } from "@opencode-ai/util/bom"
import { Formatter } from "./formatter"
import { WorkspaceEnvironment } from "./workspace/environment"

export interface Target {
  readonly canonical: string
  /** Lexical path for entry operations; remove unlinks the name, not the referent. */
  readonly absolute: string
  readonly resource: string
}

/** Seam-owned absence so tools never see backend error vocabularies. */
export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("FileMutation.NotFoundError", {
  path: Schema.String,
}) {}

/** The target resolved to a directory where a file operation was required. */
export class NotAFileError extends Schema.TaggedErrorClass<NotAFileError>()("FileMutation.NotAFileError", {
  path: Schema.String,
}) {}

/** A move wrote its destination but failed to remove the source. */
export class MoveIncompleteError extends Schema.TaggedErrorClass<MoveIncompleteError>()(
  "FileMutation.MoveIncompleteError",
  {
    from: Schema.String,
    to: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export interface WriteInput {
  readonly target: Target
  readonly content: string
}

export interface MoveInput {
  readonly from: Target
  readonly to: Target
  /** Text for the destination; may differ from the source content. */
  readonly content: string
}

export interface WriteResult {
  readonly operation: "write"
  readonly target: string
  readonly resource: string
  readonly existed: boolean
  /** Final text on disk after BOM handling and formatting. */
  readonly content: string
}

export interface Interface {
  /** Read a text file with the BOM stripped. BOM handling stays inside the seam. */
  readonly read: (target: Target) => Effect.Effect<string, NotFoundError | NotAFileError | FSUtil.Error>
  /**
   * Write logical text while retaining an existing UTF-8 BOM and emitting at
   * most one BOM. Runs configured formatters where the files live and reports
   * the final text.
   */
  readonly write: (input: WriteInput) => Effect.Effect<WriteResult, FSUtil.Error>
  /**
   * Write `content` to `to` with write semantics, then remove `from`. The
   * destination inherits the source's BOM when it has none of its own.
   */
  readonly move: (input: MoveInput) => Effect.Effect<WriteResult, MoveIncompleteError | FSUtil.Error>
  readonly remove: (target: Target) => Effect.Effect<void, NotFoundError | FSUtil.Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/FileMutation") {}

/** Normalize model-provided text to the BOM-free representation tools consume. */
export const normalizeText = (content: string) => Bom.split(content).text

const writeResult = (target: Target, existed: boolean, content: string): WriteResult => ({
  operation: "write",
  target: target.canonical,
  resource: target.resource,
  existed,
  content,
})

/** Acquire per-target locks in sorted canonical order so multi-target operations cannot deadlock. */
const lockTargets =
  (locks: KeyedMutex.KeyedMutex<string>, targets: readonly Target[]) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    [...new Set(targets.map((target) => target.canonical))]
      .sort()
      .reduceRight((locked, key) => locks.withLock(key)(locked), Effect.uninterruptible(effect))

/**
 * Serialize file changes by canonical target. Conditional writes compare and
 * write under the same process-local lock so cooperating OpenCode mutations do
 * not overwrite changes made from the same stale content.
 */
const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const formatter = yield* Formatter.Service
    const locks = KeyedMutex.makeUnsafe<string>()
    const withTargetLocks =
      (...targets: readonly Target[]) =>
      <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        lockTargets(locks, targets)(effect)

    // Happy-path reads are one operation; only the failure path stats to
    // classify a directory target.
    const read = Effect.fn("FileMutation.read")((target: Target) =>
      Bom.readFile(fs, target.canonical).pipe(
        Effect.map((content) => content.text),
        Effect.catchTag(
          "PlatformError",
          (error): Effect.Effect<never, NotFoundError | NotAFileError | FSUtil.Error> =>
            error.reason._tag === "NotFound"
              ? Effect.fail(new NotFoundError({ path: target.canonical }))
              : fs.stat(target.canonical).pipe(
                  Effect.catchTag("PlatformError", () => Effect.succeed(undefined)),
                  Effect.flatMap((info) =>
                    Effect.fail(info?.type === "Directory" ? new NotAFileError({ path: target.canonical }) : error),
                  ),
                ),
        ),
      ),
    )

    const readOptional = (path: string) =>
      fs.readFile(path).pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(undefined)))

    const writeText = (target: Target, content: string, inheritedBom: boolean) =>
      Effect.gen(function* () {
        const next = Bom.split(content)
        const current = yield* readOptional(target.canonical)
        const bom = Boolean(current && Bom.has(current)) || inheritedBom || next.bom
        yield* fs.writeWithDirs(target.canonical, Bom.join(next.text, bom))
        // Formatters may rewrite the file, so re-sync the BOM and report the
        // final text.
        const text = (yield* formatter.file(target.canonical))
          ? yield* Bom.syncFile(fs, target.canonical, bom)
          : next.text
        return writeResult(target, current !== undefined, text)
      })

    const write = Effect.fn("FileMutation.write")((input: WriteInput) =>
      withTargetLocks(input.target)(writeText(input.target, input.content, false)),
    )

    const move = Effect.fn("FileMutation.move")((input: MoveInput) =>
      withTargetLocks(
        input.from,
        input.to,
      )(
        Effect.gen(function* () {
          const source = yield* readOptional(input.from.canonical)
          const result = yield* writeText(input.to, input.content, Boolean(source && Bom.has(source)))
          yield* fs
            .remove(input.from.absolute)
            .pipe(
              Effect.mapError(
                (cause) => new MoveIncompleteError({ from: input.from.canonical, to: input.to.canonical, cause }),
              ),
            )
          return result
        }),
      ),
    )

    // Removing a symlink unlinks the link itself, never its referent.
    const remove = Effect.fn("FileMutation.remove")((target: Target) =>
      withTargetLocks(target)(
        fs
          .remove(target.absolute)
          .pipe(Effect.catchReason("PlatformError", "NotFound", () => new NotFoundError({ path: target.canonical }))),
      ),
    )

    return Service.of({ read, write, move, remove })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [FSUtil.node, Formatter.node] })

// Same cooperative locking, verbs through WorkspaceEnvironment.Files. The
// environment write reports prior existence, so no stat pre-check round trip.
// No formatting: formatters are host binaries and cannot run against provider
// paths until an environment formatter runtime exists.
const hostedLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const env = yield* WorkspaceEnvironment.Service
    const encoder = new TextEncoder()
    const locks = KeyedMutex.makeUnsafe<string>()
    const withTargetLocks =
      (...targets: readonly Target[]) =>
      <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        lockTargets(locks, targets)(effect)

    // Absence stays typed; other environment failures surface as filesystem
    // errors so tool-level messages stay uniform across backends.
    const mapError = (method: string) => (error: WorkspaceEnvironment.Error | WorkspaceEnvironment.NotFoundError) =>
      error._tag === "WorkspaceEnvironment.NotFoundError"
        ? new NotFoundError({ path: error.path })
        : new FSUtil.FileSystemError({ method, cause: error })
    const mapFileSystemError = (method: string) => (error: WorkspaceEnvironment.Error) =>
      new FSUtil.FileSystemError({ method, cause: error })

    const read = Effect.fn("FileMutation.read")((target: Target) =>
      env.files.read(target.canonical).pipe(
        Effect.map((content) => Bom.fromBytes(content).text),
        Effect.catchTag("WorkspaceEnvironment.NotFoundError", () =>
          Effect.fail(new NotFoundError({ path: target.canonical })),
        ),
        Effect.catchTag("WorkspaceEnvironment.Error", (error) =>
          env.files.stat(target.canonical).pipe(
            Effect.catch(() => Effect.succeed(undefined)),
            Effect.flatMap((info) =>
              Effect.fail(
                info?.type === "Directory"
                  ? new NotAFileError({ path: target.canonical })
                  : new FSUtil.FileSystemError({ method: "read", cause: error }),
              ),
            ),
          ),
        ),
      ),
    )

    const readOptional = (target: Target) =>
      env.files.read(target.canonical).pipe(
        Effect.catchTag("WorkspaceEnvironment.NotFoundError", () => Effect.succeed(undefined)),
        Effect.mapError(mapFileSystemError("read")),
      )

    const writeText = (target: Target, content: string, inheritedBom: boolean) =>
      Effect.gen(function* () {
        const next = Bom.split(content)
        const current = yield* readOptional(target)
        const bom = Boolean(current && Bom.has(current)) || inheritedBom || next.bom
        const result = yield* env.files
          .write(target.canonical, encoder.encode(Bom.join(next.text, bom)))
          .pipe(Effect.mapError(mapFileSystemError("write")))
        return writeResult(target, result.existed, next.text)
      })

    const write = Effect.fn("FileMutation.write")((input: WriteInput) =>
      withTargetLocks(input.target)(writeText(input.target, input.content, false)),
    )

    const move = Effect.fn("FileMutation.move")((input: MoveInput) =>
      withTargetLocks(
        input.from,
        input.to,
      )(
        Effect.gen(function* () {
          const source = yield* readOptional(input.from)
          const result = yield* writeText(input.to, input.content, Boolean(source && Bom.has(source)))
          // Keep the seam error vocabulary in the cause so tool-level messages
          // stay uniform across backends.
          yield* env.files.remove(input.from.absolute).pipe(
            Effect.mapError(
              (error) =>
                new MoveIncompleteError({
                  from: input.from.canonical,
                  to: input.to.canonical,
                  cause: mapError("remove")(error),
                }),
            ),
          )
          return result
        }),
      ),
    )

    // Removing a symlink unlinks the link itself, never its referent.
    const remove = Effect.fn("FileMutation.remove")((target: Target) =>
      withTargetLocks(target)(env.files.remove(target.absolute).pipe(Effect.mapError(mapError("remove")))),
    )

    return Service.of({ read, write, move, remove })
  }),
)

export const hostedNode = makeLocationNode({
  service: Service,
  layer: hostedLayer,
  deps: [WorkspaceEnvironment.node],
})

/**
 * Deferred until the corresponding integrations exist.
 */
// TODO: Publish watcher/file-edit events after watcher integration exists.
// TODO: Add snapshots / undo after snapshot design exists.
// TODO: Notify LSP and collect diagnostics after LSP runtime exists.
// TODO: Design multi-file transactions / rollback if patch needs atomic edits.
// Until then, edits are sequential and report partial application.
// TODO: Define crash recovery and idempotency for side effects between Tool.Called and durable settlement.
