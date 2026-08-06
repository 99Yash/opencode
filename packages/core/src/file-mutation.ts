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
  readonly absolute?: string
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

export interface WriteInput {
  readonly target: Target
  readonly content: string | Uint8Array
}

export interface TextWriteInput {
  readonly target: Target
  readonly content: string
}

export interface WriteResult {
  readonly operation: "write"
  readonly target: string
  readonly resource: string
  readonly existed: boolean
}

export interface TextWriteResult extends WriteResult {
  /** Final text on disk after BOM handling and formatting. */
  readonly content: string
}

export interface Interface {
  /** Read a text file with the BOM stripped. BOM handling stays inside the seam. */
  readonly read: (target: Target) => Effect.Effect<string, NotFoundError | NotAFileError | FSUtil.Error>
  readonly write: (input: WriteInput) => Effect.Effect<WriteResult, FSUtil.Error>
  /**
   * Write text while retaining an existing UTF-8 BOM and emitting at most one
   * BOM. Runs configured formatters where the files live and reports the
   * final text.
   */
  readonly writeTextPreservingBom: (input: TextWriteInput) => Effect.Effect<TextWriteResult, FSUtil.Error>
  readonly remove: (target: Target) => Effect.Effect<void, NotFoundError | FSUtil.Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/FileMutation") {}

/** Normalize model-provided text to the BOM-free representation tools consume. */
export const normalizeText = (content: string) => Bom.split(content).text

const writeResult = (target: Target, existed: boolean): WriteResult => ({
  operation: "write",
  target: target.canonical,
  resource: target.resource,
  existed,
})

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
    const withTargetLock =
      (target: Target) =>
      <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        locks.withLock(target.canonical)(Effect.uninterruptible(effect))

    // Happy-path reads are one operation; only the failure path stats to
    // classify a directory target.
    const read = Effect.fn("FileMutation.read")((target: Target) =>
      Bom.readFile(fs, target.canonical).pipe(
        Effect.map((content) => content.text),
        Effect.catchTag("PlatformError", (error): Effect.Effect<never, NotFoundError | NotAFileError | FSUtil.Error> =>
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

    const write = Effect.fn("FileMutation.write")((input: WriteInput) =>
      withTargetLock(input.target)(
        Effect.gen(function* () {
          const existed = yield* fs.exists(input.target.canonical)
          yield* fs.writeWithDirs(input.target.canonical, input.content)
          return writeResult(input.target, existed)
        }),
      ),
    )

    const writeTextPreservingBom = Effect.fn("FileMutation.writeTextPreservingBom")((input: TextWriteInput) =>
      withTargetLock(input.target)(
        Effect.gen(function* () {
          const next = Bom.split(input.content)
          const current = yield* fs
            .readFile(input.target.canonical)
            .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(undefined)))
          const bom = Boolean(current && Bom.has(current)) || next.bom
          yield* fs.writeWithDirs(input.target.canonical, Bom.join(next.text, bom))
          // Formatters may rewrite the file, so re-sync the BOM and report the
          // final text.
          const content = (yield* formatter.file(input.target.canonical))
            ? yield* Bom.syncFile(fs, input.target.canonical, bom)
            : next.text
          return { ...writeResult(input.target, current !== undefined), content }
        }),
      ),
    )

    // Removing a symlink unlinks the link itself, never its referent.
    const remove = Effect.fn("FileMutation.remove")((target: Target) =>
      withTargetLock(target)(
        fs
          .remove(target.absolute ?? target.canonical)
          .pipe(Effect.catchReason("PlatformError", "NotFound", () => new NotFoundError({ path: target.canonical }))),
      ),
    )

    return Service.of({ read, write, writeTextPreservingBom, remove })
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
    const withTargetLock =
      (target: Target) =>
      <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        locks.withLock(target.canonical)(Effect.uninterruptible(effect))

    const bytes = (content: string | Uint8Array) => (typeof content === "string" ? encoder.encode(content) : content)

    // Absence stays typed; other environment failures surface as filesystem
    // errors so tool-level messages stay uniform across backends.
    const mapError = (method: string) => (error: WorkspaceEnvironment.Error | WorkspaceEnvironment.NotFoundError) =>
      error._tag === "WorkspaceEnvironment.NotFoundError"
        ? new NotFoundError({ path: error.path })
        : new FSUtil.FileSystemError({ method, cause: error })

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

    const write = Effect.fn("FileMutation.write")((input: WriteInput) =>
      withTargetLock(input.target)(
        env.files
          .write(input.target.canonical, bytes(input.content))
          .pipe(
            Effect.orDie,
            Effect.map((result) => writeResult(input.target, result.existed)),
          ),
      ),
    )

    const writeTextPreservingBom = Effect.fn("FileMutation.writeTextPreservingBom")((input: TextWriteInput) =>
      withTargetLock(input.target)(
        Effect.gen(function* () {
          const next = Bom.split(input.content)
          const current = yield* WorkspaceEnvironment.optional(env.files.read(input.target.canonical))
          const text = Bom.join(next.text, Boolean(current && Bom.has(current)) || next.bom)
          const result = yield* env.files.write(input.target.canonical, bytes(text)).pipe(Effect.orDie)
          return { ...writeResult(input.target, result.existed), content: next.text }
        }),
      ),
    )

    // Removing a symlink unlinks the link itself, never its referent.
    const remove = Effect.fn("FileMutation.remove")((target: Target) =>
      withTargetLock(target)(
        env.files.remove(target.absolute ?? target.canonical).pipe(Effect.mapError(mapError("remove"))),
      ),
    )

    return Service.of({ read, write, writeTextPreservingBom, remove })
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
