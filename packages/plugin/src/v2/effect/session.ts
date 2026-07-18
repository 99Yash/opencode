import type { SessionApi } from "@opencode-ai/client/effect/api"
import type { GenerationOptionsFields, Message, SystemPart } from "@opencode-ai/ai"
import type { Agent } from "@opencode-ai/schema/agent"
import type { Model } from "@opencode-ai/schema/model"
import type { Session } from "@opencode-ai/schema/session"
import type { JsonSchema } from "effect"
import type { Hooks } from "./registration.js"

export interface SessionContext {
  readonly sessionID: Session.ID
  readonly agent: Agent.ID
  readonly model: Model.Ref
  system: Array<SystemPart>
  messages: Array<Message>
  tools: Record<string, { description: string; input: JsonSchema.JsonSchema }>
}

export type SessionGenerationOptions = {
  -readonly [Key in keyof GenerationOptionsFields]: GenerationOptionsFields[Key]
}

export type SessionProviderOptions = Record<string, Record<string, unknown>>

export interface SessionOptions {
  readonly sessionID: Session.ID
  readonly agent: Agent.ID
  readonly model: Model.Ref
  generation: SessionGenerationOptions
  providerOptions: SessionProviderOptions
}

export interface SessionHooks {
  readonly context: SessionContext
  readonly options: SessionOptions
}

export type SessionDomain = Pick<
  SessionApi<unknown>,
  "create" | "get" | "prompt" | "generate" | "command" | "synthetic" | "interrupt"
> & {
  readonly hook: Hooks<SessionHooks>
}
