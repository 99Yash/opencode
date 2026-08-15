import { describe, expect, test } from "bun:test"
import { Money } from "@opencode-ai/schema/money"
import { ModelRouting } from "@opencode-ai/core/model-routing"
import { Model } from "@opencode-ai/core/model"
import { Provider } from "@opencode-ai/core/provider"

const model = (
  providerID: string,
  id: string,
  input: readonly string[],
  options: { cost?: number; context?: number; released?: number } = {},
) =>
  Model.Info.make({
    ...Model.Info.default(Provider.ID.make(providerID), Model.ID.make(id)),
    name: id,
    capabilities: { tools: true, input: [...input], output: ["text"] },
    time: { released: options.released ?? 1 },
    cost: [
      {
        input: Money.USDPerMillionTokens.make(options.cost ?? 1),
        output: Money.USDPerMillionTokens.make(options.cost ?? 1),
        cache: { read: Money.USDPerMillionTokens.zero, write: Money.USDPerMillionTokens.zero },
      },
    ],
    limit: { context: options.context ?? 100_000, output: 10_000 },
  })

describe("ModelRouting.select", () => {
  test("routes fast work to an inexpensive fast family without selecting haiku", () => {
    const selected = ModelRouting.select("fast", [
      model("anthropic", "claude-haiku-4", ["text"], { cost: 0.1, released: 4 }),
      model("google", "gemini-flash", ["text"], { cost: 0.2, released: 3 }),
      model("openai", "gpt-5", ["text"], { cost: 2, released: 5 }),
    ])

    expect(selected).toEqual(
      Model.Ref.make({ providerID: Provider.ID.make("google"), id: Model.ID.make("gemini-flash") }),
    )
  })

  test("routes smart work to a high-capability family", () => {
    const selected = ModelRouting.select("smart", [
      model("google", "gemini-flash", ["text"], { released: 5 }),
      model("anthropic", "claude-opus-4", ["text"], { released: 3 }),
    ])

    expect(selected).toEqual(
      Model.Ref.make({ providerID: Provider.ID.make("anthropic"), id: Model.ID.make("claude-opus-4") }),
    )
  })

  test("enforces role capabilities and provider availability through the candidate set", () => {
    expect(
      ModelRouting.select("vision", [
        model("openai", "gpt-5", ["text"], { released: 5 }),
        model("google", "gemini-pro-vision", ["text", "image"], { released: 3 }),
      ]),
    ).toEqual(Model.Ref.make({ providerID: Provider.ID.make("google"), id: Model.ID.make("gemini-pro-vision") }))

    expect(
      ModelRouting.select("long-context", [
        model("openai", "gpt-5", ["text"], { context: 200_000 }),
        model("google", "gemini-pro", ["text"], { context: 1_000_000 }),
      ]),
    ).toEqual(Model.Ref.make({ providerID: Provider.ID.make("google"), id: Model.ID.make("gemini-pro") }))
  })

  test("resolves only exact models present in the available catalog", () => {
    const available = [model("xai", "grok-4", ["text"])]
    expect(ModelRouting.resolve("xai/grok-4", available)).toEqual(
      Model.Ref.make({ providerID: Provider.ID.make("xai"), id: Model.ID.make("grok-4") }),
    )
    expect(ModelRouting.resolve("xai/grok-5", available)).toBeUndefined()
  })
})
