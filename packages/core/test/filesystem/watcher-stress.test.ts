import watcher from "@parcel/watcher"
import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const backend = process.platform === "darwin" ? "fs-events" : process.platform === "linux" ? "inotify" : undefined
const describeNative = backend ? describe : describe.skip

async function descriptors() {
  if (process.platform === "linux") return fs.readdir("/proc/self/fd").then((entries) => entries.length)
  return Number(Bun.spawnSync(["sh", "-c", `lsof -p ${process.pid} 2>/dev/null | wc -l`]).stdout.toString().trim())
}

describeNative("native watcher stress diagnostic", () => {
  test(
    "releases native descriptors after repeated subscription churn",
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-watcher-stress-"))
      const targets = Array.from({ length: 20 }, (_, index) => path.join(root, `project-${index}`))
      await Promise.all(targets.map((target) => fs.mkdir(target)))
      const before = await descriptors()

      try {
        for (let round = 0; round < 100; round++) {
          const subscriptions = await Promise.all(
            targets.map((target) => watcher.subscribe(target, () => {}, { backend })),
          )
          await Promise.all(
            targets.map((target, index) => fs.writeFile(path.join(target, "event.txt"), `${round}-${index}`)),
          )
          await Promise.all(subscriptions.map((subscription) => subscription.unsubscribe()))
        }

        Bun.gc(true)
        await Bun.sleep(250)
        const after = await descriptors()
        console.log(JSON.stringify({ subscriptions: targets.length * 100, before, after }))
        expect(after - before).toBeLessThanOrEqual(4)
      } finally {
        await fs.rm(root, { recursive: true, force: true })
      }
    },
    60_000,
  )
})
