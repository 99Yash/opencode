import { describe, expect, test } from "bun:test"
import { createLiveEventDelivery, createLiveEventProjector } from "../src/protocol-live"
import type { VoiceProtocolEvent } from "../src/protocol"

const frames = [
  { type: "session.started", session: {} },
  { type: "session.context.appended", start_ms: 0, end_ms: 0 },
  { type: "output_audio.delta", audio: "AAA=", start_ms: 0, end_ms: 1 },
  {
    type: "input_transcript.added",
    start_ms: 0,
    end_ms: 100,
    item: { id: "input-1", type: "input_transcript", text: " Hello" },
  },
  { type: "turn.created", turn: { id: "user-turn", role: "user", transcript: " Hello" } },
  {
    type: "input_transcript.added",
    start_ms: 100,
    end_ms: 200,
    item: { id: "input-2", type: "input_transcript", text: ", this" },
  },
  { type: "turn.delta", turn_id: "user-turn", delta: ", this" },
  {
    type: "output_transcript.added",
    start_ms: 200,
    end_ms: 300,
    item: { id: "output-1", type: "output_transcript", text: " Copy that" },
  },
  {
    type: "input_transcript.added",
    start_ms: 200,
    end_ms: 300,
    item: { id: "input-3", type: "input_transcript", text: " is a test" },
  },
  {
    type: "output_transcript.added",
    start_ms: 300,
    end_ms: 400,
    item: { id: "output-2", type: "output_transcript", text: ", test" },
  },
  { type: "turn.delta", turn_id: "user-turn", delta: " is a test" },
  { type: "turn.done", turn: { id: "user-turn", role: "user", transcript: " Hello, this is a test" } },
  { type: "turn.created", turn: { id: "assistant-turn", role: "assistant", transcript: " Copy that, test" } },
  {
    type: "output_transcript.added",
    start_ms: 400,
    end_ms: 500,
    item: { id: "output-3", type: "output_transcript", text: " received" },
  },
  { type: "turn.delta", turn_id: "assistant-turn", delta: " received" },
  {
    type: "output_transcript.added",
    start_ms: 500,
    end_ms: 600,
    item: { id: "output-4", type: "output_transcript", text: " loud and clear." },
  },
  { type: "turn.delta", turn_id: "assistant-turn", delta: " loud and clear." },
  {
    type: "turn.done",
    turn: { id: "assistant-turn", role: "assistant", transcript: " Copy that, test received loud and clear." },
  },
] as const

describe("Live event projector", () => {
  test("replays progressive transcripts without schema errors or duplicate text", () => {
    const project = createLiveEventProjector()
    const events = frames.flatMap((frame) => project(JSON.stringify(frame)).events)

    expect(events.filter((event) => event.type === "error")).toEqual([])
    expect(events.filter((event) => event.type === "user.committed")).toEqual([
      { type: "user.committed", id: "input-1" },
    ])
    expect(events.filter(isUserTranscript)).toEqual([
      { type: "user.transcript", id: "input-1", text: "Hello", final: false },
      { type: "user.transcript", id: "input-1", text: "Hello, this", final: false },
      { type: "user.transcript", id: "input-1", text: "Hello, this is a test", final: false },
      { type: "user.transcript", id: "input-1", text: "Hello, this is a test", final: true },
    ])
    expect(
      events
        .filter(isAssistantDelta)
        .map((event) => event.delta)
        .join(""),
    ).toBe(" Copy that, test received loud and clear.")
    expect(events.filter((event) => event.type === "assistant.done")).toEqual([
      { type: "assistant.done", awaitingWork: false },
    ])
    expect(events.filter((event) => event.type === "assistant.audio")).toHaveLength(1)
  })

  test("reports malformed frames instead of throwing", () => {
    expect(createLiveEventProjector()(JSON.stringify({ type: "turn.created", turn: { id: 1 } })).events).toEqual([
      { type: "error", message: "Received an invalid Live API event." },
    ])
  })

  test("preserves context acknowledgement correlation IDs", () => {
    expect(
      createLiveEventProjector()(
        JSON.stringify({ type: "session.context.appended", event_id: "event-notification" }),
      ),
    ).toMatchObject({
      type: "session.context.appended",
      eventID: "event-notification",
    })
  })

  test("replaces corrected assistant transcript snapshots", () => {
    const project = createLiveEventProjector()
    const events = [
      project(
        JSON.stringify({
          type: "output_transcript.added",
          item: { id: "output-1", type: "output_transcript", text: " Hello world" },
        }),
      ),
      project(
        JSON.stringify({
          type: "turn.created",
          turn: { id: "assistant-turn", role: "assistant", transcript: " Hello there" },
        }),
      ),
    ].flatMap((result) => result.events)

    expect(events.filter((event) => event.type.startsWith("assistant.transcript"))).toEqual([
      { type: "assistant.transcript.delta", delta: " Hello world" },
      { type: "assistant.transcript", text: " Hello there" },
    ])
  })

  test("keeps the space between consecutive assistant turns", () => {
    const project = createLiveEventProjector()
    const turn = (id: string, text: string) => [
      { type: "turn.created", turn: { id, role: "assistant", transcript: "" } },
      { type: "output_transcript.added", item: { id: `${id}-o`, type: "output_transcript", text } },
      { type: "turn.delta", turn_id: id, delta: text },
      { type: "turn.done", turn: { id, role: "assistant", transcript: text } },
    ]
    const events = [...turn("t1", ' Session "Fix auth bug" is ready.'), ...turn("t2", " Next up, tests.")].flatMap(
      (frame) => project(JSON.stringify(frame)).events,
    )

    // Concatenating the delta stream is what the UI and any transcript consumer does; the
    // turn boundary must survive it rather than welding "ready.Next" together.
    const transcript = events
      .filter(isAssistantDelta)
      .map((event) => event.delta)
      .join("")
    expect(transcript).toBe(' Session "Fix auth bug" is ready. Next up, tests.')
    expect(transcript).not.toContain("ready.Next")
    expect(events.filter((event) => event.type === "assistant.done")).toHaveLength(2)
  })

  test("emits no duplicate text when fragments and turn deltas overlap across turns", () => {
    const project = createLiveEventProjector()
    const frames = [
      { type: "turn.created", turn: { id: "t1", role: "assistant", transcript: "" } },
      { type: "output_transcript.added", item: { id: "a", type: "output_transcript", text: " First" } },
      { type: "turn.delta", turn_id: "t1", delta: " First" },
      { type: "output_transcript.added", item: { id: "b", type: "output_transcript", text: " turn." } },
      { type: "turn.delta", turn_id: "t1", delta: " turn." },
      { type: "turn.done", turn: { id: "t1", role: "assistant", transcript: " First turn." } },
      { type: "turn.created", turn: { id: "t2", role: "assistant", transcript: "" } },
      { type: "output_transcript.added", item: { id: "c", type: "output_transcript", text: " Second turn." } },
      { type: "turn.delta", turn_id: "t2", delta: " Second turn." },
      { type: "turn.done", turn: { id: "t2", role: "assistant", transcript: " Second turn." } },
    ]
    const events = frames.flatMap((frame) => project(JSON.stringify(frame)).events)

    expect(events.filter((event) => event.type === "assistant.transcript")).toEqual([])
    expect(
      events
        .filter(isAssistantDelta)
        .map((event) => event.delta)
        .join(""),
    ).toBe(" First turn. Second turn.")
  })

  test("projects Responses delegation function calls without rejecting reasoning items", () => {
    const project = createLiveEventProjector()
    expect(
      project(
        JSON.stringify({
          type: "response.output_item.done",
          item: { id: "reasoning-1", type: "reasoning" },
        }),
      ).events,
    ).toEqual([{ type: "debug", message: "response.output_item.done" }])
    expect(
      project(
        JSON.stringify({
          type: "response.output_item.added",
          item: {
            id: "function-1",
            type: "function_call",
            name: "find_sessions",
            call_id: "call-1",
            arguments: "",
          },
        }),
      ).events,
    ).toEqual([
      { type: "debug", message: "response.output_item.added" },
      { type: "tool.started", id: "call-1", name: "find_sessions" },
    ])
    expect(
      project(
        JSON.stringify({
          type: "response.output_item.done",
          item: {
            id: "function-1",
            type: "function_call",
            name: "find_sessions",
            call_id: "call-1",
            arguments: '{"scope":"current_project"}',
          },
        }),
      ).events,
    ).toEqual([
      { type: "debug", message: "response.output_item.done" },
      {
        type: "work.requested",
        request: { id: "call-1", name: "find_sessions", input: { scope: "current_project" } },
      },
    ])
    expect(
      project(
        JSON.stringify({
          type: "response.output_item.done",
          item: {
            id: "message-1",
            type: "message",
            status: "completed",
            content: [{ type: "output_text", text: "Two sessions found." }],
            role: "assistant",
          },
        }),
      ).events,
    ).toEqual([{ type: "debug", message: "response.output_item.done" }])
  })

  test("projects client delegation requests for the local controller", () => {
    expect(
      createLiveEventProjector()(
        JSON.stringify({
          type: "delegation.created",
          item: {
            id: "delegation-1",
            type: "delegation",
            target: "client",
            content: [{ type: "input_text", text: "Inspect the voice package" }],
          },
        }),
      ).events,
    ).toEqual([
      { type: "debug", message: "delegation.created" },
      { type: "delegation.requested", request: { id: "delegation-1", text: "Inspect the voice package" } },
    ])
  })

  test("rejects malformed function arguments without hanging the delegation", () => {
    expect(
      createLiveEventProjector()(
        JSON.stringify({
          type: "response.output_item.done",
          item: {
            id: "function-1",
            type: "function_call",
            name: "find_sessions",
            call_id: "call-invalid",
            arguments: "not json",
          },
        }),
      ).events,
    ).toEqual([
      { type: "debug", message: "response.output_item.done" },
      { type: "tool.started", id: "call-invalid", name: "find_sessions" },
      { type: "error", message: "Received invalid arguments for Live tool find_sessions." },
      {
        type: "work.rejected",
        request: { id: "call-invalid", name: "find_sessions", input: {} },
        output: { status: "error", message: "Invalid arguments for tool find_sessions." },
      },
    ])
  })

  test("waits for a quiet drain after turn completion and late audio", async () => {
    const events: VoiceProtocolEvent[] = []
    const delivery = createLiveEventDelivery({ emit: (event) => events.push(event), drainMs: 20 })
    delivery.push({ type: "assistant.done", awaitingWork: false })
    await Bun.sleep(10)
    delivery.push({ type: "assistant.audio", audio: Buffer.alloc(48) })
    await Bun.sleep(12)
    expect(events.map((event) => event.type)).toEqual(["assistant.audio"])
    await Bun.sleep(12)
    expect(events.map((event) => event.type)).toEqual(["assistant.audio", "assistant.done"])
    delivery.close()
  })
})

function isUserTranscript(
  event: VoiceProtocolEvent,
): event is Extract<VoiceProtocolEvent, { readonly type: "user.transcript" }> {
  return event.type === "user.transcript"
}

function isAssistantDelta(
  event: VoiceProtocolEvent,
): event is Extract<VoiceProtocolEvent, { readonly type: "assistant.transcript.delta" }> {
  return event.type === "assistant.transcript.delta"
}
