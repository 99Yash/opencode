import { expect } from "bun:test"
import { LLM, LLMClient, Model as LLMModel } from "@opencode-ai/ai"
import { OpenAIChat } from "@opencode-ai/ai/protocols"
import type { LLMClientShape, OptionsTransform } from "@opencode-ai/ai/route"
import { Agent } from "@opencode-ai/schema/agent"
import { Model } from "@opencode-ai/schema/model"
import { Provider } from "@opencode-ai/schema/provider"
import { Session } from "@opencode-ai/schema/session"
import { Effect, Layer, Stream } from "effect"
import { PluginHooks } from "../src/plugin/hooks"
import { SessionOptionsHook } from "../src/session/options-hook"
import { testEffect } from "./lib/effect"

const layer = PluginHooks.node.implementation as Layer.Layer<PluginHooks.Service>
const it = testEffect(layer)

it.effect("applies session option hooks to resolved model options", () =>
  Effect.gen(function* () {
    const hooks = yield* PluginHooks.Service
    const sessionID = Session.ID.make("ses_options")
    const agent = Agent.ID.make("build")
    const model = Model.Ref.make({ providerID: Provider.ID.make("test"), id: Model.ID.make("model") })
    yield* hooks.register("session", "options", (event) =>
      Effect.sync(() => {
        expect(event).toMatchObject({ sessionID, agent, model })
        event.generation.temperature = 0.2
        delete event.generation.topP
        event.providerOptions.openai ??= {}
        event.providerOptions.openai.reasoningEffort = "high"
      }),
    )
    let transform: OptionsTransform | undefined
    const llm: LLMClientShape = {
      prepare: () => Effect.die("unused"),
      stream: () => Stream.die("unused"),
      generate: () => Effect.die("unused"),
      withOptionsTransform: (next) => {
        transform = next
        return llm
      },
    }

    SessionOptionsHook.client(llm, hooks, { sessionID, agent, model })
    if (!transform) return yield* Effect.die("options transform was not installed")
    const result = yield* transform(
      LLM.request({
        model: LLMModel.make({ id: "model", provider: "test", route: OpenAIChat.route }),
        generation: { temperature: 0.7, topP: 0.9 },
        providerOptions: { openai: { promptCacheKey: "cache" } },
      }),
    )

    expect(result.generation).toMatchObject({ temperature: 0.2 })
    expect(result.generation?.topP).toBeUndefined()
    expect(result.providerOptions).toEqual({ openai: { promptCacheKey: "cache", reasoningEffort: "high" } })
  }),
)
