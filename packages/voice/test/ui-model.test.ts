import { describe, expect, test } from "bun:test"
import { initialVoiceView, transitionVoiceView, type VoiceViewEvent, type VoiceViewState } from "../src/ui-model"

const apply = (state: VoiceViewState, ...events: ReadonlyArray<VoiceViewEvent>) =>
  events.reduce(transitionVoiceView, state)

describe("VoiceView", () => {
  test("keeps assistant responses separated by a committed user turn", () => {
    const state = apply(
      initialVoiceView(),
      { type: "assistant.delta", text: "First response.", now: 0, animate: false },
      { type: "user.committed", itemID: "user-1" },
      { type: "user.transcript", itemID: "user-1", text: "Next request", final: true, now: 1, animate: false },
      { type: "assistant.delta", text: "Second response.", now: 2, animate: false },
    )
    expect(state.messages.map((message) => message.kind)).toEqual(["assistant", "user", "assistant"])
    expect(state.messages.flatMap((message) => ("text" in message ? [message.text] : []))).toEqual([
      "First response.",
      "Next request",
      "Second response.",
    ])
  })

  test("keeps local sound activity out of transcript history", () => {
    const started = transitionVoiceView(initialVoiceView(), { type: "user.started" })
    expect(started.messages).toEqual([])
    const committed = transitionVoiceView(started, { type: "user.committed", itemID: "user-1" })
    expect(committed.messages).toEqual([
      { key: "message-1", kind: "user", itemID: "user-1", transcribing: true, reveals: [] },
    ])

    const abandoned = apply(initialVoiceView(), { type: "user.started" }, { type: "user.reset" })
    expect(abandoned.messages).toEqual([])
  })

  test("deduplicates transcript snapshots and clears completed reveals", () => {
    const state = apply(
      initialVoiceView(),
      { type: "user.committed", itemID: "user-1" },
      { type: "user.transcript", itemID: "user-1", text: "Hello", final: false, now: 0, animate: true },
      { type: "user.transcript", itemID: "user-1", text: "Hello", final: false, now: 10, animate: true },
    )
    expect(state.messages).toHaveLength(1)
    expect(state.messages[0]?.kind === "user" ? state.messages[0].reveals.length : 0).toBeGreaterThan(0)
    expect(transitionVoiceView(state, { type: "reveals.completed" }).messages).toEqual([
      { key: "message-1", kind: "user", itemID: "user-1", text: "Hello", transcribing: true, reveals: [] },
    ])
  })

  test("bounds message history", () => {
    const state = Array.from({ length: 205 }, (_, index) => index).reduce(
      (current, index) => transitionVoiceView(current, { type: "meta", text: String(index) }),
      initialVoiceView(),
    )
    expect(state.messages).toHaveLength(200)
    expect(state.messages[0]).toEqual({ key: "message-6", kind: "meta", text: "5" })
  })

  test("settles tool completion before or after insertion", () => {
    const inserted = apply(
      initialVoiceView(),
      { type: "tool.started", callID: "call-1", name: "read_session", input: {} },
      { type: "tool.done", callID: "call-1", output: { status: "ok" } },
    )
    expect(inserted.messages[0]).toEqual({
      key: "message-1",
      kind: "tool",
      callID: "call-1",
      name: "read_session",
      input: {},
      output: { status: "ok" },
    })
  })
})
