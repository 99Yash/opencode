import { Effect } from "effect"
import { define } from "@opencode-ai/plugin/effect/plugin"
import { Provider } from "../../provider.js"

export const MergeGatewayPlugin = define({
  id: "opencode.provider.merge-gateway",
  effect: Effect.fn(function* (ctx) {
    yield* ctx.catalog.transform((evt) => {
      for (const item of evt.provider.list()) {
        for (const model of item.models.values()) {
          if (Provider.packageName(model.package ?? item.provider.package) !== "merge-gateway-ai-sdk-provider") continue
          evt.model.update(model.providerID, model.id, (model) => {
            // The gateway's Chat envelope differs from the upstream model's catalog defaults.
            model.compatibility = {
              ...model.compatibility,
              reasoningField: "thinking",
              maxTokensField: "max_tokens",
              requireReasoning: false,
            }
          })
        }
      }
    })
  }),
})
