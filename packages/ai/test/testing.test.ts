import { expect } from "bun:test"
import { Effect } from "effect"
import { LLM, LLMClient, LLMEvent } from "../src"
import { OpenAIChat } from "../src/protocols"
import { TestLLM } from "../src/testing"
import { testEffect } from "./lib/effect"

const model = OpenAIChat.route.model({ id: "test" })
const it = testEffect(TestLLM.layerWithClient({ fallback: TestLLM.text("Hello") }))

it.effect("provides a client and exposes received requests", () =>
  Effect.gen(function* () {
    const response = yield* LLMClient.generate(LLM.request({ model, prompt: "Say hello" }))

    expect(response.text).toBe("Hello")
    expect(response.events.filter(LLMEvent.is.textDelta)).toEqual([{ type: "text-delta", id: "text-0", text: "Hello" }])
    expect(yield* TestLLM.requests).toHaveLength(1)
  }),
)
