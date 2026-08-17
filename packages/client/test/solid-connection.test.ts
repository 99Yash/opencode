import { describe, expect, test } from "bun:test"
import type { OpenCodeEvent } from "../src/promise"
import { coalesceClientEvents } from "../src/solid/connection"

describe("coalesceClientEvents", () => {
  const delta = (id: string, value: string, ordinal = 0) =>
    ({
      id,
      created: 1,
      type: "session.text.delta",
      location: { directory: "/repo" },
      data: { sessionID: "ses", assistantMessageID: "msg", ordinal, delta: value },
    }) as OpenCodeEvent

  test("merges adjacent deltas for the same stream", () => {
    const result = coalesceClientEvents([delta("evt_1", "hello "), delta("evt_2", "world")])
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ id: "evt_2", data: { delta: "hello world" } })
  })

  test("coalesces tool input deltas by tool ID", () => {
    const current = (eventID: string, id: string, value: string) =>
      ({
        id: eventID,
        created: 1,
        type: "session.tool.input.delta",
        location: { directory: "/repo" },
        data: { sessionID: "ses", assistantMessageID: "msg", id, delta: value },
      }) as OpenCodeEvent
    const result = coalesceClientEvents([
      current("evt_1", "call_1", "{"),
      current("evt_2", "call_1", "}"),
      current("evt_3", "call_2", "[]"),
    ])
    expect(result).toHaveLength(2)
    expect(result[0]).toMatchObject({ id: "evt_2", data: { id: "call_1", delta: "{}" } })
    expect(result[1]).toMatchObject({ id: "evt_3", data: { id: "call_2", delta: "[]" } })
  })

  test("preserves boundaries between distinct delta streams", () => {
    const events = [delta("evt_1", "a"), delta("evt_2", "b", 1), delta("evt_3", "c")]
    expect(coalesceClientEvents(events).map((event) => event.id)).toEqual(["evt_1", "evt_2", "evt_3"])
  })
})
