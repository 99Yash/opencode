import { expect, test } from "bun:test"
import { createNotificationRouter, type RoutedAnnouncement } from "../src/notification-router"

test("routes blockers and completions through the admitted delegation", () => {
  const routed: RoutedAnnouncement[] = []
  const router = createNotificationRouter((announcement) => routed.push(announcement))
  router.beginDelegatedTool()
  router.route({
    notification: {
      type: "opencode.prompt.blocked",
      prompt_id: "prompt-1",
      blocker: "permission",
      session_id: "session-1",
      request_id: "permission-1",
      action: "read",
      resources: [],
    },
  })
  expect(routed).toEqual([])

  router.finishDelegatedTool("delegation-1", { sessionID: "session-1", promptID: "prompt-1" })
  router.route({
    notification: {
      type: "opencode.prompt.completed",
      session_id: "session-1",
      prompt_id: "prompt-1",
      status: "completed",
      text: "done",
    },
    receipt: { sessionID: "session-1", promptID: "prompt-1" },
  })

  expect(routed.map((item) => item.delegationID)).toEqual(["delegation-1", "delegation-1"])
  expect(routed[0].announcement.receipt).toBeUndefined()
  expect(routed[1].announcement.receipt).toEqual({ sessionID: "session-1", promptID: "prompt-1" })
})

test("keeps identical prompt IDs isolated by session", () => {
  const routed: RoutedAnnouncement[] = []
  const router = createNotificationRouter((announcement) => routed.push(announcement))
  router.beginDelegatedTool()
  router.finishDelegatedTool("delegation-1", { sessionID: "session-1", promptID: "prompt-shared" })
  router.beginDelegatedTool()
  router.finishDelegatedTool("delegation-2", { sessionID: "session-2", promptID: "prompt-shared" })

  for (const sessionID of ["session-1", "session-2"])
    router.route({
      notification: {
        type: "opencode.prompt.completed",
        session_id: sessionID,
        prompt_id: "prompt-shared",
        status: "completed",
        text: "done",
      },
      receipt: { sessionID, promptID: "prompt-shared" },
    })

  expect(routed.map((item) => item.delegationID)).toEqual(["delegation-1", "delegation-2"])
})
