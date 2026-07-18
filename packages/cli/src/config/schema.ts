import { Config } from "@opencode-ai/tui/config"
import { Schema } from "effect"

export const Server = Schema.Struct({
  url: Schema.String,
  username: Schema.optional(Schema.String),
  password: Schema.optional(Schema.String),
})
export type Server = Schema.Schema.Type<typeof Server>

export const Info = Schema.Struct({
  ...Config.Info.fields,
  servers: Schema.optional(Schema.Record(Schema.String, Server)),
})
export type Info = Schema.Schema.Type<typeof Info>
