import {
  Agent,
  Command,
  Connection,
  Credential,
  Integration,
  Mcp,
  Model,
  Plugin,
  Provider,
  Reference,
  Skill,
  WebSearch,
} from "@opencode-ai/plugin"

const key = Symbol.for("opencode.plugin.v2.promise")
;(globalThis as typeof globalThis & { [key]?: unknown })[key] = {
  Agent,
  Command,
  Connection,
  Credential,
  Integration,
  Mcp,
  Model,
  Plugin,
  Provider,
  Reference,
  Skill,
  WebSearch,
}
