import {
  Agent,
  Command,
  Connection,
  Credential,
  Effect,
  Integration,
  Mcp,
  Model,
  Plugin,
  Provider,
  Reference,
  Schema,
  Skill,
  WebSearch,
} from "@opencode-ai/plugin/effect"
import { Tool } from "@opencode-ai/schema/tool"

const key = Symbol.for("opencode.plugin.v2.effect")
;(globalThis as typeof globalThis & { [key]?: unknown })[key] = {
  Agent,
  Command,
  Connection,
  Credential,
  Effect,
  Integration,
  Mcp,
  Model,
  Plugin,
  Provider,
  Reference,
  Schema,
  Skill,
  WebSearch,
  Tool: { Error: Tool.Error },
}
