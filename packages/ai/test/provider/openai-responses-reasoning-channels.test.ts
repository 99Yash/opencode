import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { LLM, LLMEvent } from "../../src/index.js"
import { Auth, LLMClient } from "../../src/route.js"
import { compileRequest } from "../../src/route/client.js"
import { OpenAIResponses } from "../../src/protocols/index.js"
import { it } from "../lib/effect.js"
import { fixedResponse } from "../lib/http.js"
import { sseEvents } from "../lib/sse.js"

const model = OpenAIResponses.route
  .with({ endpoint: { baseURL: "https://api.openai.test/v1/" }, auth: Auth.bearer("test") })
  .model({ id: "reasoning-model" })
const request = LLM.request({ model, prompt: "Think it through." })
const completed = { type: "response.completed", response: { id: "resp_1" } }
const generate = (...events: OpenAIResponses.Event[]) =>
  LLMClient.generate(request).pipe(Effect.provide(fixedResponse(sseEvents(...events))))

describe("OpenAI Responses reasoning channels", () => {
  it.effect("replaces provisional raw reasoning when a summary starts", () =>
    Effect.gen(function* () {
      const response = yield* generate(
        { type: "response.output_item.added", item: { type: "reasoning", id: "rs_1" } },
        {
          type: "response.reasoning_text.delta",
          item_id: "rs_1",
          content_index: 0,
          delta: "Internal detail.",
        },
        {
          type: "response.reasoning_summary_text.delta",
          item_id: "rs_1",
          summary_index: 0,
          delta: "Visible summary.",
        },
        {
          type: "response.output_item.done",
          item: {
            type: "reasoning",
            id: "rs_1",
            summary: [{ type: "summary_text", text: "Visible summary." }],
            content: [{ type: "reasoning_text", text: "Internal detail." }],
            encrypted_content: "state",
          },
        },
        completed,
      )

      const deltas = response.events.filter(LLMEvent.is.reasoningDelta)
      expect(deltas.map((event) => event.text)).toEqual(["Internal detail.", "Visible summary."])
      expect(deltas[0]?.id).not.toBe(deltas[1]?.id)
      expect(response.events.find((event) => event.type === "reasoning-end" && event.id === deltas[0]?.id)?.text).toBe(
        "",
      )
      expect(response.reasoning).toBe("Visible summary.")
    }),
  )

  it.effect("does not mix raw reasoning into an active summary", () =>
    Effect.gen(function* () {
      const response = yield* generate(
        { type: "response.output_item.added", item: { type: "reasoning", id: "rs_1" } },
        { type: "response.reasoning_summary_text.delta", item_id: "rs_1", summary_index: 0, delta: "Summary." },
        { type: "response.reasoning_text.delta", item_id: "rs_1", content_index: 0, delta: "Internal detail." },
        {
          type: "response.output_item.done",
          item: {
            type: "reasoning",
            id: "rs_1",
            summary: [{ type: "summary_text", text: "Summary." }],
            content: [{ type: "reasoning_text", text: "Internal detail." }],
          },
        },
        completed,
      )

      expect(response.events.filter(LLMEvent.is.reasoningDelta).map((event) => event.text)).toEqual(["Summary."])
      expect(response.reasoning).toBe("Summary.")
    }),
  )

  it.effect("does not let raw deltas suppress a summary final", () =>
    Effect.gen(function* () {
      const response = yield* generate(
        { type: "response.output_item.added", item: { type: "reasoning", id: "rs_1" } },
        { type: "response.reasoning_text.delta", item_id: "rs_1", content_index: 0, delta: "Internal " },
        { type: "response.reasoning_text.done", item_id: "rs_1", content_index: 1, text: "draft." },
        {
          type: "response.reasoning_summary_text.done",
          item_id: "rs_1",
          summary_index: 0,
          text: "Final summary.",
        },
        {
          type: "response.output_item.done",
          item: {
            type: "reasoning",
            id: "rs_1",
            content: [{ type: "reasoning_text", text: "Raw final." }],
            encrypted_content: "state",
          },
        },
        completed,
      )

      expect(response.reasoning).toBe("Raw final.")
      expect(response.events.filter(LLMEvent.is.reasoningDelta).map((event) => event.text)).toEqual([
        "Internal ",
        "draft.",
        "Final summary.",
      ])
    }),
  )

  it.effect("keeps raw-only reasoning visible without replaying it as a summary", () =>
    Effect.gen(function* () {
      for (const done of [
        undefined,
        {
          type: "response.output_item.done",
          item: {
            type: "reasoning",
            id: "rs_1",
            summary: [],
            content: [{ type: "reasoning_text", text: "Internal detail." }],
          },
        } satisfies OpenAIResponses.Event,
      ]) {
        const response = yield* generate(
          {
            type: "response.output_item.added",
            item: { type: "reasoning", id: "rs_1", encrypted_content: "state" },
          },
          { type: "response.reasoning_text.delta", item_id: "rs_1", content_index: 0, delta: "Internal detail." },
          ...(done ? [done] : []),
          completed,
        )

        expect(response.reasoning).toBe("Internal detail.")
        const prepared = yield* compileRequest(
          LLM.request({ model, messages: [response.message], providerOptions: { store: false } }),
        )
        expect(prepared.body.input).toEqual([
          { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "state" },
        ])
      }
    }),
  )

  it.effect("separates a summary first supplied by item completion", () =>
    Effect.gen(function* () {
      for (const boundary of [
        undefined,
        {
          type: "response.reasoning_summary_part.added",
          item_id: "rs_1",
          summary_index: 1,
        } satisfies OpenAIResponses.Event,
      ]) {
        const response = yield* generate(
          { type: "response.output_item.added", item: { type: "reasoning", id: "rs_1" } },
          { type: "response.reasoning_text.delta", item_id: "rs_1", content_index: 0, delta: "Internal detail." },
          ...(boundary ? [boundary] : []),
          {
            type: "response.output_item.done",
            item: {
              type: "reasoning",
              id: "rs_1",
              summary: [
                { type: "summary_text", text: "First" },
                { type: "summary_text", text: "Second" },
              ],
              content: [{ type: "reasoning_text", text: "Internal detail." }],
              encrypted_content: "state",
            },
          },
          completed,
        )

        const ended = response.events.filter(LLMEvent.is.reasoningEnd)
        expect(ended.map((event) => event.text)).toEqual(["", "First\n\nSecond"])
        expect(ended[0]?.id).not.toBe(ended[1]?.id)
        expect(response.reasoning).toBe("First\n\nSecond")
      }
    }),
  )

  it.effect("merges raw and summary history for an empty item ID", () =>
    Effect.gen(function* () {
      const response = yield* generate(
        { type: "response.output_item.added", item: { type: "reasoning", id: "", encrypted_content: null } },
        { type: "response.reasoning_text.delta", item_id: "", delta: "Internal detail." },
        { type: "response.reasoning_summary_text.delta", item_id: "", delta: "Visible summary." },
        {
          type: "response.output_item.done",
          item: {
            type: "reasoning",
            id: "",
            summary: [{ type: "summary_text", text: "Visible summary." }],
            encrypted_content: "state",
          },
        },
        completed,
      )
      const prepared = yield* compileRequest(
        LLM.request({ model, messages: [response.message], providerOptions: { store: false } }),
      )

      expect(prepared.body.input).toEqual([
        {
          type: "reasoning",
          summary: [{ type: "summary_text", text: "Visible summary." }],
          encrypted_content: "state",
        },
      ])
    }),
  )
})
