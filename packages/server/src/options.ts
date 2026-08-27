import { ApplicationOptions } from "@opencode-ai/core/application/options"
import { Schema } from "effect"

export const ServerOptions = Schema.Struct({
  ...ApplicationOptions.Options.fields,
  hostname: Schema.optional(Schema.String),
  port: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(65_535))),
  password: Schema.optional(Schema.String),
  simulation: Schema.optional(Schema.Boolean),
})
export type ServerOptions = typeof ServerOptions.Type
