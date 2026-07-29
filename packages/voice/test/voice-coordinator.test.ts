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
    const notification = { id: "notification-1", promptID: "prompt-1", text: "completed" }
    const waiting = apply(
      initialVoiceState("marin"),
      { type: "connection.ready" },
      { type: "user.committed" },
      { type: "notification.queued", notification },
    )
    expect(waiting.commands).toEqual([])

    expect(transitionVoice(waiting.state, { type: "assistant.done", awaitingWork: false })).toEqual({
      state: {
        ...waiting.state,
        conversation: "waiting",
        assistant: "idle",
        notifications: [],
        delivery: { notification, phase: "sending" },
      },
      commands: [
        { type: "assistant.finish", awaitingWork: false, notificationID: undefined },
        { type: "notification.send", notification },
      ],
    })
  })

  test("keeps notifications queued while the user is speaking", () => {
    const notification = { id: "notification-1", text: "completed" }
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
    const notification = { id: "notification-1", text: "completed" }
    const result = apply(
      initialVoiceState("marin"),
      { type: "connection.ready" },
      { type: "tool.started", id: "call-1" },
      { type: "assistant.done", awaitingWork: false },
      { type: "notification.queued", notification },
    )
    expect(result.commands).toEqual([
      { type: "assistant.finish", awaitingWork: false, notificationID: undefined },
    ])
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
    expect(idle.commands).toEqual([
      { type: "assistant.finish", awaitingWork: false, notificationID: undefined },
      { type: "connection.reconnect" },
    ])
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
    const notification = { id: "notification-1", text: "completed" }
    const sent = apply(
      initialVoiceState("marin"),
      { type: "connection.ready" },
      { type: "notification.queued", notification },
    )
    const failed = transitionVoice(sent.state, { type: "notification.failed", id: notification.id })
    expect(failed.state.notifications).toEqual([notification])
    expect(failed.state.connection).toBe("connecting")
    expect(failed.commands).toEqual([{ type: "connection.reconnect" }])
  })

  test("keeps a notification in flight until its playback completes", () => {
    const notification = { id: "notification-1", promptID: "prompt-1", text: "completed" }
    const sent = apply(
      initialVoiceState("marin"),
      { type: "connection.ready" },
      {
        type: "notification.queued",
        notification,
      },
    )
    expect(sent.state.delivery).toEqual({ notification, phase: "sending" })

    const accepted = transitionVoice(sent.state, { type: "notification.accepted", id: notification.id }).state
    expect(accepted.delivery).toEqual({ notification, phase: "accepted" })
    const speaking = transitionVoice(accepted, { type: "assistant.started" }).state
    expect(speaking.delivery).toEqual({ notification, phase: "announcing" })
    const generated = transitionVoice(speaking, { type: "assistant.done", awaitingWork: false })
    expect(generated.state.delivery).toEqual({ notification, phase: "awaiting-playback" })
    expect(generated.commands).toEqual([
      { type: "assistant.finish", awaitingWork: false, notificationID: notification.id },
    ])
    expect(transitionVoice(generated.state, { type: "notification.announced", id: notification.id })).toEqual({
      state: { ...generated.state, delivery: undefined },
      commands: [{ type: "notification.delivered", notification }],
    })
  })

  test("does not attribute an already-active assistant turn to a newly appended notification", () => {
    const notification = { id: "notification-1", text: "completed" }
    const active = apply(
      initialVoiceState("marin"),
      { type: "connection.ready" },
      { type: "notification.queued", notification },
      { type: "assistant.started" },
      { type: "notification.accepted", id: notification.id },
    ).state

    expect(active.delivery).toEqual({ notification, phase: "accepted" })
    const existingDone = transitionVoice(active, { type: "assistant.done", awaitingWork: false })
    expect(existingDone.state.delivery).toEqual({ notification, phase: "accepted" })
    expect(existingDone.commands).toEqual([
      { type: "assistant.finish", awaitingWork: false, notificationID: undefined },
    ])
    expect(transitionVoice(existingDone.state, { type: "assistant.started" }).state.delivery).toEqual({
      notification,
      phase: "announcing",
    })
  })

  test("keeps assistant activity independent from a full-duplex user commit", () => {
    const active = apply(initialVoiceState("marin"), { type: "connection.ready" }, { type: "assistant.started" }).state
    const committed = transitionVoice(active, { type: "user.committed" }).state
    expect(committed.assistant).toBe("active")
    expect(committed.conversation).toBe("responding")
  })

  test("ignores stale notification callbacks", () => {
    const notification = { id: "notification-2", text: "current" }
    const sent = apply(
      initialVoiceState("marin"),
      { type: "connection.ready" },
      { type: "notification.queued", notification },
    ).state

    expect(transitionVoice(sent, { type: "notification.accepted", id: "notification-1" })).toEqual({
      state: sent,
      commands: [],
    })
    expect(transitionVoice(sent, { type: "notification.failed", id: "notification-1" })).toEqual({
      state: sent,
      commands: [],
    })
    expect(transitionVoice(sent, { type: "notification.announced", id: "notification-1" })).toEqual({
      state: sent,
      commands: [],
    })
  })

  test("waits for one announcement playback before sending the next", () => {
    const first = { id: "notification-1", text: "first" }
    const second = { id: "notification-2", text: "second" }
    const sent = apply(
      initialVoiceState("marin"),
      { type: "connection.ready" },
      { type: "notification.queued", notification: first },
      { type: "notification.queued", notification: second },
      { type: "notification.accepted", id: first.id },
      { type: "assistant.started" },
      { type: "assistant.done", awaitingWork: false },
    )
    expect(sent.state.delivery).toEqual({ notification: first, phase: "awaiting-playback" })
    expect(sent.state.notifications).toEqual([second])

    expect(transitionVoice(sent.state, { type: "notification.announced", id: first.id })).toEqual({
      state: {
        ...sent.state,
        conversation: "waiting",
        delivery: { notification: second, phase: "sending" },
        notifications: [],
      },
      commands: [
        { type: "notification.delivered", notification: first },
        { type: "notification.send", notification: second },
      ],
    })
  })

  test("keeps an announcement active across tool work", () => {
    const notification = { id: "notification-1", text: "completed" }
    const announcing = apply(
      initialVoiceState("marin"),
      { type: "connection.ready" },
      { type: "notification.queued", notification },
      { type: "notification.accepted", id: notification.id },
      { type: "assistant.started" },
    ).state
    expect(transitionVoice(announcing, { type: "assistant.done", awaitingWork: true }).state.delivery).toEqual({
      notification,
      phase: "announcing",
    })
  })

  test("requeues an interrupted announcement and reconnects before retrying", () => {
    const notification = { id: "notification-1", text: "completed" }
    const awaitingPlayback = apply(
      initialVoiceState("marin"),
      { type: "connection.ready" },
      { type: "notification.queued", notification },
      { type: "notification.accepted", id: notification.id },
      { type: "assistant.started" },
      { type: "assistant.done", awaitingWork: false },
    ).state
    const interrupted = transitionVoice(awaitingPlayback, {
      type: "notification.interrupted",
      id: notification.id,
    })
    expect(interrupted.state.connection).toBe("connecting")
    expect(interrupted.state.notifications).toEqual([notification])
    expect(interrupted.commands).toEqual([{ type: "connection.reconnect" }])
  })

  test("holds an interrupted announcement reconnect until barge-in speech stops", () => {
    const notification = { id: "notification-1", text: "completed" }
    const announcing = apply(
      initialVoiceState("marin"),
      { type: "connection.ready" },
      { type: "notification.queued", notification },
      { type: "notification.accepted", id: notification.id },
      { type: "assistant.started" },
    ).state
    const barged = transitionVoice(announcing, { type: "user.started", bargeIn: true })
    expect(barged.state.notifications).toEqual([notification])
    expect(barged.state.userSpeaking).toBe(true)
    expect(barged.state.connection).toBe("ready")
    expect(barged.commands).toEqual([{ type: "assistant.interrupt" }])

    expect(transitionVoice(barged.state, { type: "user.stopped" }).commands).toEqual([
      { type: "connection.reconnect" },
    ])
  })
})
