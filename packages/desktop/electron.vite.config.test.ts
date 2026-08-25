import { expect, test } from "bun:test"
import config from "./electron.vite.config"

test("uses the current Rolldown Electron main entry without externalizing the Node browser client", () => {
  expect(config.main?.build?.externalizeDeps).toEqual({
    include: [`@lydell/node-pty-${process.platform}-${process.arch}`],
  })
  expect(config.main?.build?.rolldownOptions?.input).toEqual({ index: "src/main/index.ts" })
})

test("keeps the bundled Node client out of packaged production dependencies", async () => {
  const pkg = await Bun.file("package.json").json()
  expect(pkg.dependencies["@opencode-ai/client"]).toBeUndefined()
  expect(pkg.devDependencies["@opencode-ai/client"]).toBe("workspace:*")
})
