import { expect, test } from "bun:test"
import { resolve } from "node:path"

test("question form projections use reactive Solid browser exports", async () => {
  const child = Bun.spawn(
    [process.execPath, "test", "--conditions=browser", "--timeout=5000", "./test/solid-form.browser.ts"],
    { cwd: resolve(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" },
  )
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect(exitCode, stdout + stderr).toBe(0)
})
