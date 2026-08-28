export * as Plugin from "./plugin.js"

import { Schema } from "effect"
import { ephemeral, inventory } from "./event.js"
import { optional } from "./schema.js"

export const ID = Schema.String.pipe(Schema.brand("Plugin.ID"))
export type ID = typeof ID.Type

export const Source = Schema.Union([
  Schema.Struct({ type: Schema.Literal("builtin") }),
  Schema.Struct({ type: Schema.Literal("package"), package: Schema.String }),
  Schema.Struct({ type: Schema.Literal("local"), path: Schema.String }),
  Schema.Struct({ type: Schema.Literal("sdk") }),
]).annotate({ identifier: "Plugin.Source" })
export type Source = typeof Source.Type

export const Info = Schema.Union([
  Schema.Struct({
    id: ID,
    source: Source,
    status: Schema.Literal("active"),
    tui: Schema.Boolean,
    revision: optional(Schema.String).annotate({ description: "Loaded root package version or full Git commit." }),
    generation: optional(Schema.String).annotate({
      description: "Opaque loaded module graph identity, local to this runtime.",
    }),
    error: optional(Schema.String).annotate({
      description: "The last replacement failed; the reported revision is still active.",
    }),
  }),
  Schema.Struct({
    id: ID.pipe(optional),
    source: Source,
    status: Schema.Literal("failed"),
    error: Schema.String,
    tui: Schema.Boolean,
    revision: optional(Schema.String).annotate({ description: "Registered root package version or full Git commit." }),
    generation: optional(Schema.String).annotate({
      description: "Opaque registered module graph identity, local to this runtime.",
    }),
  }),
]).annotate({ identifier: "Plugin.Info" })
export type Info = typeof Info.Type

export interface PackageStatus extends Schema.Schema.Type<typeof PackageStatus> {}
export const PackageStatus = Schema.Struct({
  installed: optional(Schema.String),
  available: optional(Schema.String),
  mutable: Schema.Boolean,
}).annotate({ identifier: "Plugin.PackageStatus" })

export class OperationError extends Schema.TaggedError<OperationError>()("PluginOperationError", {
  message: Schema.String,
}) {}

const Added = ephemeral({
  type: "plugin.added",
  schema: { id: ID },
})
const Updated = ephemeral({
  type: "plugin.updated",
  schema: {},
})
export const Event = { Added, Updated, Definitions: inventory(Added, Updated) }
