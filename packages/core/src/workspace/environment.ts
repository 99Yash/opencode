export * as WorkspaceEnvironment from "./environment"

import { Context, Effect, FileSystem, Schema } from "effect"
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"

export class Error extends Schema.TaggedErrorClass<Error>()("WorkspaceEnvironment.Error", {
  operation: Schema.String,
  path: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Defect()),
}) {}

/** Distinct so callers (e.g. the LocationMutation ancestor walk) can catch absence. */
export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("WorkspaceEnvironment.NotFoundError", {
  path: Schema.String,
}) {}

export interface FileInfo {
  readonly type: FileSystem.File.Type
}

export interface DirectoryEntry {
  readonly name: string
  readonly type: "file" | "directory" | "symlink" | "other"
}

/**
 * The minimal primitive set the hosted implementations of Filesystem,
 * LocationMutation, and FileMutation consume. Grow it only when a real
 * consumer appears.
 */
export interface Files {
  readonly stat: (path: string) => Effect.Effect<FileInfo, Error | NotFoundError>
  /** Canonical path with symlinks resolved; identity for permissions and locking. */
  readonly realPath: (path: string) => Effect.Effect<string, Error | NotFoundError>
  readonly read: (path: string) => Effect.Effect<Uint8Array, Error | NotFoundError>
  readonly list: (path: string) => Effect.Effect<readonly DirectoryEntry[], Error | NotFoundError>
  /** Creates parent directories, matching FSUtil.writeWithDirs. */
  readonly write: (path: string, content: Uint8Array) => Effect.Effect<void, Error>
}

export interface Shell {
  readonly executable: string
  readonly args: (command: string) => readonly string[]
  readonly environmentOverrides: Readonly<Record<string, string>>
  readonly detached: boolean
}

export interface Interface {
  readonly platform: NodeJS.Platform
  /** The Workspace root, absolute in the provider filesystem. */
  readonly directory: string
  readonly files: Files
  readonly process: ChildProcessSpawner["Service"]
  readonly shell: Shell
}

export class Service extends Context.Service<Service, Interface>()("@opencode/WorkspaceEnvironment") {}

/** Identity constructor so environment literals get contextual typing. */
export const make = (environment: Interface) => environment

/** Default lowering for Linux sandbox images. */
export const linuxShell: Shell = {
  executable: "/bin/bash",
  args: (command) => ["-c", command],
  environmentOverrides: {},
  detached: false,
}
