import { describe, expect, test } from "bun:test"
import { initialVoiceState, transitionVoice, type VoiceEvent, type VoiceState } from "../src/voice-coordinator"

const apply = (state: VoiceState, ...events: ReadonlyArray<VoiceEvent>) =>
  events.reduce(
    (result, event) => {
      const next = transitionVoice(result.state, event)
      return { state: next.state, commands: [...result.commands, ...next.commands] }
    },
    { state, commands: [] as Array<ReturnType<typeof transitionVoice>["commands"][number]> },
  )

describe("VoiceCoordinator", () => {
  test("delivers one notification at a time when the server becomes idle", () => {
    const notification = { promptID: "prompt-1", text: "completed" }
    const waiting = apply(
      initialVoiceState("marin"),
      { type: "connection.ready" },
      { type: "user.committed" },
      { type: "notification.queued", notification },
    )
    expect(waiting.commands).toEqual([])

    expect(transitionVoice(waiting.state, { type: "assistant.done", awaitingWork: false })).toEqual({
      state: { ...waiting.state, conversation: "waiting", assistant: "idle", notifications: [] },
      commands: [{ type: "notification.send", notification }],
    })
  })

  test("keeps notifications queued while the user is speaking", () => {
    const notification = { text: "completed" }
    const result = apply(
      initialVoiceState("marin"),
      { type: "connection.ready" },
      { type: "user.started" },
      { type: "notification.queued", notification },
    )
    expect(result.commands).toEqual([])
    expect(result.state.notifications).toEqual([notification])
    expect(transitionVoice(result.state, { type: "user.stopped" }).commands).toEqual([
      { type: "notification.send", notification },
    ])
  })

  test("keeps notifications queued until active tool calls finish", () => {
    const notification = { text: "completed" }
    const result = apply(
      initialVoiceState("marin"),
      { type: "connection.ready" },
      { type: "tool.started", id: "call-1" },
      { type: "assistant.done", awaitingWork: false },
      { type: "notification.queued", notification },
    )
    expect(result.commands).toEqual([])
    expect(transitionVoice(result.state, { type: "tool.finished", id: "call-1" }).commands).toEqual([
      { type: "notification.send", notification },
    ])
  })

  test("tracks tools by call ID and reconnects only after work and conversation settle", () => {
    const busy = apply(
      initialVoiceState("marin"),
      { type: "connection.ready" },
      { type: "tool.started", id: "call-1" },
      { type: "voice.selected", voice: "cedar" },
    )
    expect(busy.commands).toEqual([])
    expect(transitionVoice(busy.state, { type: "tool.finished", id: "call-1" }).commands).toEqual([])

    const idle = transitionVoice(transitionVoice(busy.state, { type: "tool.finished", id: "call-1" }).state, {
      type: "assistant.done",
      awaitingWork: false,
    })
    expect(idle.commands).toEqual([{ type: "connection.reconnect" }])
    expect(idle.state.connection).toBe("connecting")
  })

  test("a user commit closes assistant suppression and establishes a waiting boundary", () => {
    const suppressed = apply(
      initialVoiceState("marin"),
      { type: "connection.ready" },
      { type: "assistant.started" },
      { type: "assistant.suppressed" },
      { type: "user.committed" },
    )
    expect(suppressed.state.assistant).toBe("idle")
    expect(suppressed.state.conversation).toBe("waiting")
  })

  test("requeues a notification when the adapter rejects it", () => {
    const notification = { text: "completed" }
    const sent = apply(
      initialVoiceState("marin"),
      { type: "connection.ready" },
      { type: "notification.queued", notification },
    )
    const failed = transitionVoice(sent.state, { type: "notification.failed", notification })
    expect(failed.state.notifications).toEqual([notification])
    expect(failed.state.connection).toBe("connecting")
    expect(failed.commands).toEqual([{ type: "connection.reconnect" }])
  })
})
