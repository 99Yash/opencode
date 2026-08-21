import { expect, test } from "@playwright/test"
import { assistantMessage, setupTimeline, toolPart, userMessage } from "../performance/timeline-stability/fixture"
import { createTwoFilesPatch } from "diff"

test("labels single-file patches by operation", async ({ page }) => {
  const cases = [
    { id: "prt_created_patch", file: "src/new.ts", status: "added" as const, title: "Created" },
    { id: "prt_removed_patch", file: "src/old.ts", status: "deleted" as const, title: "Removed" },
    { id: "prt_modified_patch", file: "src/current.ts", status: "modified" as const, title: "Patch" },
  ]
  await setupTimeline(page, {
    messages: [
      userMessage(),
      assistantMessage(
        cases.map((item) =>
          toolPart(
            item.id,
            "patch",
            "completed",
            { patchText: `Update ${item.file}` },
            { metadata: { files: [patchFile(item.file, item.status)] } },
          ),
        ),
      ),
    ],
  })

  for (const item of cases) {
    await expect(page.locator(`[data-timeline-part-id="${item.id}"]`).getByLabel(item.title, { exact: true })).toBeVisible()
  }
  await expect(
    page.locator('[data-timeline-part-id="prt_created_patch"] [data-slot="message-part-actions"] [data-component="diff-changes"]'),
  ).toHaveCount(0)
  await expect(
    page.locator('[data-timeline-part-id="prt_removed_patch"] [data-slot="message-part-actions"] [data-component="diff-changes"]'),
  ).toHaveCount(0)
  await expect(
    page.locator('[data-timeline-part-id="prt_modified_patch"] [data-slot="message-part-actions"] [data-component="diff-changes"]'),
  ).toHaveCount(1)
})

test("preserves nested patch file state through outer collapse and reopen", async ({ page }) => {
  const patchID = "prt_nested_patch"
  const files = [patchFile("src/a.ts", "modified"), patchFile("src/b.ts", "added"), patchFile("src/old.ts", "deleted")]
  await setupTimeline(page, {
    messages: [
      userMessage(),
      assistantMessage([
        toolPart(
          patchID,
          "patch",
          "completed",
          { patchText: "Update three files" },
          { metadata: { files } },
        ),
      ]),
    ],
    settings: { editToolPartsExpanded: true },
  })
  const wrapper = page.locator(`[data-timeline-part-id="${patchID}"]`)
  const outer = wrapper.locator('[data-slot="collapsible-trigger"]').first()
  const deleted = wrapper.locator('[data-scope="apply-patch"] [data-type="delete"]')
  await deleted.getByRole("button").click()
  await expect(deleted.getByRole("button")).toHaveAttribute("aria-expanded", "true")
  await outer.click()
  await expect(outer).toHaveAttribute("aria-expanded", "false")
  await outer.click()
  await expect(outer).toHaveAttribute("aria-expanded", "true")
  await expect(deleted.getByRole("button")).toHaveAttribute("aria-expanded", "true")
})

function patchFile(file: string, status: "added" | "modified" | "deleted") {
  const before = status === "added" ? "" : source(false)
  const after = status === "deleted" ? "" : source(true)
  return {
    file,
    status,
    patch: createTwoFilesPatch(`a/${file}`, `b/${file}`, before, after),
    additions: status === "deleted" ? 0 : 4,
    deletions: status === "added" ? 0 : 3,
  }
}

function source(changed: boolean) {
  return Array.from({ length: 12 }, (_, index) => `export const value${index} = ${changed ? index + 1 : index}\n`).join(
    "",
  )
}
