import { describe, expect, test } from "bun:test"
import type { SessionInboxInfo, SessionMessageInfo } from "@opencode-ai/client/promise"
import { visibleTimelineMessages } from "./controller-projection"
import { wire } from "../../test-fixture"
import { SessionMessage } from "@opencode-ai/schema/session-message"

const messages = wire<SessionMessageInfo[]>([
  { id: "msg_1", type: "user", text: "first", time: { created: 1 } },
  {
    id: "msg_2",
    type: "assistant",
    agent: "build",
    model: { id: "model", providerID: "provider" },
    content: [],
    time: { created: 2 },
  },
  { id: "msg_3", type: "user", text: "queued", time: { created: 3 } },
  { id: "msg_4", type: "user", text: "reverted", time: { created: 4 } },
])

describe("visibleTimelineMessages", () => {
  test("hides queued inputs until delivery", () => {
    const pending = wire<SessionInboxInfo[]>([
      {
        id: "msg_3",
        sessionID: "ses_1",
        timeCreated: 3,
        type: "user",
        delivery: "queue",
        payload: { text: "queued" },
      },
    ])

    expect(visibleTimelineMessages(messages, pending).map((message) => String(message.id))).toEqual([
      "msg_1",
      "msg_2",
      "msg_4",
    ])
  })

  test("hides the staged revert boundary and later messages", () => {
    expect(
      visibleTimelineMessages(messages, [], SessionMessage.ID.make("msg_4")).map((message) => String(message.id)),
    ).toEqual(["msg_1", "msg_2", "msg_3"])
    expect(visibleTimelineMessages(messages, [], SessionMessage.ID.make("msg_0"))).toEqual([])
  })
})
