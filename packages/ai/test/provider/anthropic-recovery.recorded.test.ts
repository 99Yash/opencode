import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { LLM, Message, ToolCallPart, ToolDefinition } from "../../src/index.js"
import { configure } from "../../src/providers/anthropic.js"
import { LLMClient } from "../../src/route.js"
import { recordedTests } from "../recorded-test.js"

const model = configure({
  apiKey: process.env.ZEN_TEST_API_KEY ?? "fixture",
  baseURL: "https://opencode.ai/zen/v1",
}).model("claude-sonnet-4-6")
const continuation =
  "The previous response was interrupted. Continue from where you left off without repeating completed content."
const lookup = ToolDefinition.make({
  name: "lookup_weather",
  description: "Return benign weather data for a city.",
  inputSchema: {
    type: "object",
    properties: { city: { type: "string" } },
    required: ["city"],
  },
})
const recorded = recordedTests({
  prefix: "anthropic-recovery",
  provider: "anthropic",
  protocol: "anthropic-messages",
  requires: ["ZEN_TEST_API_KEY"],
  options: { redact: { allowRequestHeaders: ["anthropic-version"] } },
})

describe("Anthropic interrupted recovery recorded", () => {
  recorded.effect.with(
    "accepts a synthetic settled tool call followed by continuation",
    { tags: ["tool", "recovery"] },
    () =>
      Effect.gen(function* () {
        const response = yield* LLMClient.generate(
          LLM.request({
            id: "recorded_anthropic_interrupted_tool_recovery",
            model,
            messages: [
              Message.user("Look up the weather in Paris."),
              Message.assistant([
                { type: "text", text: "I should use the weather tool." },
                ToolCallPart.make({ id: "call_weather", name: "lookup_weather", input: { city: "Paris" } }),
              ]),
              Message.tool({ id: "call_weather", name: "lookup_weather", result: "sunny", resultType: "text" }),
              Message.user(continuation),
            ],
            tools: [lookup],
            toolChoice: "none",
            generation: { maxTokens: 128, temperature: 0 },
          }),
        )

        expect(response.text.trim().length).toBeGreaterThan(0)
      }),
  )
})
