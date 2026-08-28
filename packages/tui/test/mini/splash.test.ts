import { afterEach, expect, test } from "bun:test"
import { createTestRenderer, type TestRenderer } from "@opentui/core/testing"
import { entrySplash } from "../../src/mini/splash"
import { RUN_THEME_FALLBACK } from "../../src/mini/theme"

type Commit = {
  snapshot: {
    height: number
    getRealCharBytes(addLineBreaks?: boolean): Uint8Array
    destroy(): void
  }
}

const active: TestRenderer[] = []

afterEach(() => {
  for (const renderer of active.splice(0)) renderer.destroy()
})

async function render(mono: boolean) {
  const out = await createTestRenderer({
    width: 80,
    screenMode: "split-footer",
    footerHeight: 4,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
  })
  const renderer = out.renderer
  active.push(renderer)
  renderer.writeToScrollback(
    entrySplash({
      title: undefined,
      session_id: "ses_test",
      theme: RUN_THEME_FALLBACK.splash,
      detail: "~/project",
      version: "1.18.4",
      mono,
    }),
  )
  const queue = Reflect.get(renderer, "externalOutputQueue") as { claim(): Commit[] }
  const commits = queue.claim()
  const text = new TextDecoder().decode(commits[0]!.snapshot.getRealCharBytes(true)).replace(/ +\n/g, "\n")
  commits.forEach((commit) => commit.snapshot.destroy())
  return text
}

test("renders the compact Mini identity", async () => {
  expect(await render(false)).toContain("◼ oc mini v1.18.4 · ~/project")
})

test("renders an ASCII compact identity in monochrome mode", async () => {
  expect(await render(true)).toContain("[O] oc mini v1.18.4 - ~/project")
})
