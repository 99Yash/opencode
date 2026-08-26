import { expect, test } from "@playwright/test"
import {
  assistantMessage,
  partUpdated,
  setupTimeline,
  toolPart,
  userMessage,
} from "../performance/timeline-stability/fixture"

test("preserves surviving grouped patch state when its first patch fails", async ({ page }) => {
  const failed = "prt_grouped_patch_failed"
  const surviving = "prt_grouped_patch_surviving"
  const timeline = await setupTimeline(page, {
    messages: [
      userMessage(),
      assistantMessage(
        [
          toolPart(failed, "patch", "running", { patchText: "Update src/failed.ts" }),
          toolPart(
            surviving,
            "patch",
            "running",
            { patchText: "Update src/surviving.ts" },
            {
              metadata: {
                files: [
                  {
                    file: "src/surviving.ts",
                    status: "modified",
                    patch: "@@ -1 +1 @@\n-export const value = 1\n+export const value = 2",
                    additions: 1,
                    deletions: 1,
                  },
                ],
              },
            },
          ),
        ],
        { completed: false },
      ),
    ],
  })

  const group = page.locator(`[data-timeline-part-ids="${failed},${surviving}"]`)
  const file = group.locator('[data-scope="apply-patch"] button')
  await expect(file).toBeVisible()
  await file.click()
  await expect(file).toHaveAttribute("aria-expanded", "true")
  await group.evaluate((element) => {
    const row = element.closest<HTMLElement>("[data-timeline-key]")
    if (row) row.dataset.groupIdentity = "preserved"
  })

  await timeline.send(
    partUpdated(
      toolPart(failed, "patch", "error", { patchText: "Update src/failed.ts" }, { error: "Patch failed visibly" }),
    ),
  )

  const failedRow = page.locator("[data-timeline-key]", {
    has: page.locator(`[data-timeline-part-id="${failed}"]`),
  })
  const survivingRow = page.locator("[data-timeline-key]", {
    has: page.locator(`[data-timeline-part-id="${surviving}"]`),
  })
  await expect(failedRow).toHaveAttribute("data-timeline-key", /^assistant-part:part:/)
  await expect(survivingRow).toHaveAttribute("data-timeline-key", /^assistant-part:file:/)
  await expect(failedRow.getByText("Patch failed visibly")).toBeVisible()
  await expect(survivingRow).toHaveAttribute("data-group-identity", "preserved")
  await expect(survivingRow.locator('[data-scope="apply-patch"] button')).toHaveAttribute("aria-expanded", "true")
  await expect
    .poll(async () => {
      const previous = await failedRow.boundingBox()
      const next = await survivingRow.boundingBox()
      return previous && next ? next.y - (previous.y + previous.height) : Number.NEGATIVE_INFINITY
    })
    .toBeGreaterThanOrEqual(-0.5)
})
