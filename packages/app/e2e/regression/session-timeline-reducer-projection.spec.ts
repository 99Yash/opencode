import { expect, test } from "@playwright/test"
import {
  assistantMessage,
  completedAssistantInfo,
  messageUpdated,
  partUpdated,
  renderedPartID,
  setupTimeline,
  status,
  textPart,
  userMessage,
} from "../performance/timeline-stability/fixture"

test("reducer-hardening: converges when idle arrives before final part and message completion", async ({ page }) => {
  const textID = "prt_event_order_text"
  const assistant = assistantMessage([textPart(textID, "Partial")], { completed: false })
  const timeline = await setupTimeline(page, { messages: [userMessage(), assistant] })
  await timeline.send(status("busy"), 100)
  await timeline.send(status("idle"), 100)
  await timeline.send(partUpdated(textPart(textID, "Final after early idle")), 120)
  await timeline.send(messageUpdated(completedAssistantInfo(assistant)), 250)

  await expect(page.locator('[data-timeline-row="Thinking"]')).toHaveCount(0)
  await expect(page.locator(`[data-timeline-part-id="${renderedPartID(textID)}"]`)).toContainText(
    "Final after early idle",
  )
})
