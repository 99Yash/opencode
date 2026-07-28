import { expect, test } from "bun:test"
import config from "./electron.vite.config"

test("bundles the Node client into the packaged main process", () => {
  expect(config.main?.build?.externalizeDeps).toEqual({ exclude: ["@opencode-ai/client"] })
})

test("keeps the bundled Node client out of packaged production dependencies", async () => {
  const pkg = await Bun.file("package.json").json()
  expect(pkg.dependencies["@opencode-ai/client"]).toBeUndefined()
  expect(pkg.devDependencies["@opencode-ai/client"]).toBe("workspace:*")
})
