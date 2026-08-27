export * as ApplicationOptions from "./options.js"

import { Schema } from "effect"
import { Database } from "../database/database.js"
import { ModelsDev } from "../models-dev.js"

export const Options = Schema.Struct({
  app: Schema.optional(
    Schema.Struct({
      name: Schema.optional(Schema.String),
      version: Schema.optional(Schema.String),
      channel: Schema.optional(Schema.String),
    }),
  ),
  database: Schema.optional(Database.Options),
  events: Schema.optional(Schema.Struct({ persist: Schema.optional(Schema.Boolean) })),
  models: Schema.optional(ModelsDev.Options),
  config: Schema.optional(
    Schema.Struct({
      directory: Schema.optional(Schema.String),
      project: Schema.optional(Schema.Boolean),
      file: Schema.optional(Schema.String),
      content: Schema.optional(Schema.String),
    }),
  ),
  windows: Schema.optional(Schema.Struct({ gitbash: Schema.optional(Schema.String) })),
  fs: Schema.optional(
    Schema.Struct({
      filewatcher: Schema.optional(Schema.Boolean),
      fff: Schema.optional(Schema.Boolean),
    }),
  ),
})
export type Options = typeof Options.Type
