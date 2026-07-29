import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { decodeVoiceToolInput } from "../src/protocol"
import { createLiveContextAppendQueue, liveNotificationAcknowledgement } from "../src/protocol-live"
import { realtimeNotificationAcknowledgement, realtimeSessionUpdate } from "../src/protocol-realtime"
import { createSingleFlightAcknowledgement } from "../src/single-flight-acknowledgement"
import { openCodeAnnouncementText } from "../src/opencode-notification"

describe("voice protocol", () => {
  test("accepts only JSON object tool arguments", () => {
    expect(Option.getOrUndefined(decodeVoiceToolInput('{"text":"hello","nested":{"value":1}}'))).toEqual({
      text: "hello",
      nested: { value: 1 },
    })
    for (const input of ["not json", "null", "[]", "1", '"text"'])
      expect(Option.getOrUndefined(decodeVoiceToolInput(input))).toBeUndefined()
  })

  test("correlates Realtime notification acknowledgements", () => {
    const pending = { itemID: "item-current", eventID: "event-current" }
    expect(
      realtimeNotificationAcknowledgement(
        { type: "conversation.item.created", item: { id: "item-current" } },
        pending,
      ),
    ).toBe(true)
    expect(
      realtimeNotificationAcknowledgement(
        { type: "conversation.item.created", item: { id: "item-other" } },
        pending,
      ),
    ).toBeUndefined()
    expect(
      realtimeNotificationAcknowledgement(
        { type: "error", error: { event_id: "event-current" } },
        pending,
      ),
    ).toBe(false)
  })

  test("preserves tool schemas in Realtime session updates", () => {
    const tools = [
      {
        type: "function" as const,
        name: "open_form",
        description: "Open form",
        parameters: {
          type: "object",
          properties: { answer: { type: "object", additionalProperties: true } },
          additionalProperties: true,
        },
      },
    ]
    expect(JSON.parse(JSON.stringify(realtimeSessionUpdate({ instructions: "test", tools, voice: "marin" }))).session.tools)
      .toEqual(tools)
  })

  test("correlates Live notification acknowledgements by expected context", () => {
    const pending = { eventID: "event-current", acknowledgement: "delegation.context.appended" as const }
    expect(
      liveNotificationAcknowledgement(
        { type: "delegation.context.appended", eventID: "event-current" },
        pending,
      ),
    ).toBe(true)
    expect(
      liveNotificationAcknowledgement({ type: "session.context.appended", eventID: "event-current" }, pending),
    ).toBeUndefined()
    expect(
      liveNotificationAcknowledgement(
        { type: "delegation.context.appended", eventID: "event-other" },
        pending,
      ),
    ).toBe(true)
    expect(
      liveNotificationAcknowledgement({ type: "error", errorEventID: "event-current" }, pending),
    ).toBe(false)
  })

  test("serializes indistinguishable Live context appends", async () => {
    const sent: Array<Record<string, unknown>> = []
    const queue = createLiveContextAppendQueue({
      send: (event) => {
        sent.push(event)
        return true
      },
      timeoutMs: 100,
    })
    const first = queue.append(
      { type: "delegation.context.append", event_id: "event-1" },
      "delegation.context.appended",
    )
    const second = queue.append(
      { type: "delegation.context.append", event_id: "event-2" },
      "delegation.context.appended",
    )
    expect(sent.map((event) => event["event_id"])).toEqual(["event-1"])

    queue.receive({ type: "session.context.appended", eventID: "unrelated" })
    expect(sent.map((event) => event["event_id"])).toEqual(["event-1"])
    queue.receive({ type: "delegation.context.appended", eventID: "not-echoed" })
    expect(await first).toBe(true)
    expect(sent.map((event) => event["event_id"])).toEqual(["event-1", "event-2"])
    queue.receive({ type: "delegation.context.appended" })
    expect(await second).toBe(true)
    queue.close()
  })

  test("keeps notification acknowledgement single-flight", async () => {
    const acknowledgement = createSingleFlightAcknowledgement<{ readonly token: string }>(50)
    const first = acknowledgement.begin("notification-1", { token: "first" })
    const second = acknowledgement.begin("notification-2", { token: "second" })

    expect(first.started).toBe(true)
    expect(second.started).toBe(false)
    expect(await second.promise).toBe(false)
    expect(acknowledgement.current()).toEqual({ id: "notification-1", correlation: { token: "first" } })
    acknowledgement.settle("notification-1", true)
    expect(await first.promise).toBe(true)
    expect(acknowledgement.current()).toBeUndefined()
  })

  test("renders bounded conversational OpenCode announcements without identifiers", () => {
    const text = openCodeAnnouncementText({
      type: "opencode.prompt.completed",
      session_id: "ses_private",
      prompt_id: "msg_private",
      status: "completed",
      text: "finished ".repeat(200),
    })
    expect(text.length).toBeLessThanOrEqual(800)
    expect(text).not.toContain("ses_private")
    expect(text).not.toContain("msg_private")
    expect(text).toStartWith("OpenCode prompt completed: finished")
  })

})
