export * as SessionOptionsHook from "./options-hook"

import { LLM } from "@opencode-ai/ai"
import type { LLMClientShape } from "@opencode-ai/ai/route"
import type { SessionHooks } from "@opencode-ai/plugin/v2/effect/session"
import { Effect } from "effect"
import { PluginHooks } from "../plugin/hooks"

type Identity = Pick<SessionHooks["options"], "sessionID" | "agent" | "model">

export const client = (llm: LLMClientShape, hooks: PluginHooks.Interface, identity: Identity) =>
  hooks.has("session", "options")
    ? llm.withOptionsTransform((request) =>
        Effect.gen(function* () {
          const event = yield* hooks.trigger("session", "options", {
            ...identity,
            generation: { ...request.generation },
            providerOptions: structuredClone(request.providerOptions ?? {}),
          })
          return LLM.updateRequest(request, {
            generation: event.generation,
            providerOptions: event.providerOptions,
          })
        }),
      )
    : llm
