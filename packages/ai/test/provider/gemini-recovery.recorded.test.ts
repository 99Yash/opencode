import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { LLM, Message, ToolCallPart, ToolDefinition } from "../../src/index.js"
import { configure } from "../../src/providers/google.js"
import { LLMClient } from "../../src/route.js"
import { recordedTests } from "../recorded-test.js"

const model = configure({
  apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? "fixture",
}).model("gemini-3.5-flash")
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
  prefix: "gemini-recovery",
  provider: "google",
  protocol: "gemini",
  requires: ["GOOGLE_GENERATIVE_AI_API_KEY"],
})

describe("Gemini interrupted recovery recorded", () => {
  recorded.effect.with(
    "accepts an unsigned settled tool call followed by continuation",
    { tags: ["tool", "recovery"] },
    () =>
      Effect.gen(function* () {
        const response = yield* LLMClient.generate(
          LLM.request({
            id: "recorded_gemini_interrupted_tool_recovery",
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
            generation: { maxTokens: 256, temperature: 0 },
          }),
        )

        expect(response.text.trim().length).toBeGreaterThan(0)
      }),
  )
})
