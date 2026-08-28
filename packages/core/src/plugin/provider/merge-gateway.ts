import { Effect } from "effect"
import { define } from "@opencode-ai/plugin/effect/plugin"
import { Provider } from "../../provider.js"

export const MergeGatewayPlugin = define({
  id: "opencode.provider.merge-gateway",
  effect: Effect.fn(function* (ctx) {
    yield* ctx.catalog.transform((evt) => {
      for (const item of evt.provider.list()) {
        const merge = Provider.packageName(item.provider.package) === "merge-gateway-ai-sdk-provider"
        for (const model of item.models.values()) {
          if (Provider.packageName(model.package ?? item.provider.package) !== "merge-gateway-ai-sdk-provider") {
            if (merge)
              evt.model.update(model.providerID, model.id, (model) => {
                model.settings = Provider.mergeOverlay(item.provider.settings, model.settings)
              })
            continue
          }
          evt.model.update(model.providerID, model.id, (model) => {
            if (model.package) model.package = "@opencode-ai/ai/providers/openai-compatible"
            model.settings = {
              ...(!merge ? { baseURL: "https://api-gateway.merge.dev/v1/ai-sdk", provider: model.providerID } : {}),
              ...settings(merge ? model.settings : Provider.mergeOverlay(item.provider.settings, model.settings)),
            }
            // Merge uses `thinking` instead of the usual OpenAI-compatible reasoning fields.
            // models.dev tracks upstream models, not these gateway-specific compatibility defaults.
            model.compatibility = {
              ...model.compatibility,
              reasoningField: "thinking",
              maxTokensField: "max_tokens",
              requireReasoning: false,
            }
          })
        }
        if (!merge) continue
        evt.provider.update(item.provider.id, (provider) => {
          provider.package = "@opencode-ai/ai/providers/openai-compatible"
          provider.settings = {
            baseURL: "https://api-gateway.merge.dev/v1/ai-sdk",
            provider: provider.id,
            ...settings(provider.settings),
          }
        })
      }
    })
  }),
})

function settings(input: Readonly<Record<string, unknown>> = {}) {
  const options = Object.fromEntries(Object.entries(input).filter(([key]) => key !== "apiKey" && key !== "baseURL"))
  return {
    ...(typeof input.apiKey === "string" ? { apiKey: input.apiKey } : {}),
    ...(typeof input.baseURL === "string" ? { baseURL: input.baseURL } : {}),
    ...(Object.keys(options).length ? { providerOptions: options } : {}),
  }
}
