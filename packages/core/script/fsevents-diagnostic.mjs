import watcher from "@parcel/watcher"
import { execFileSync } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const rounds = Number(process.env.FSEVENTS_ROUNDS ?? 100)
const width = Number(process.env.FSEVENTS_WIDTH ?? 25)
const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-fsevents-"))
const targets = Array.from({ length: width }, (_, index) => path.join(root, `project-${index}`))
await Promise.all(targets.map((target) => fs.mkdir(target)))

function openFiles() {
  try {
    return Number(execFileSync("sh", ["-c", `lsof -p ${process.pid} 2>/dev/null | wc -l`], { encoding: "utf8" }).trim())
  } catch {
    return -1
  }
}

function sample(round) {
  const memory = process.memoryUsage()
  console.log(
    JSON.stringify({
      round,
      subscriptions: round * width,
      rss: memory.rss,
      heapUsed: memory.heapUsed,
      external: memory.external,
      openFiles: openFiles(),
    }),
  )
}

try {
  sample(0)
  for (let round = 1; round <= rounds; round++) {
    const subscriptions = await Promise.all(
      targets.map((target) => watcher.subscribe(target, () => {}, { backend: "fs-events" })),
    )
    await Promise.all(
      targets.map((target, index) => fs.writeFile(path.join(target, "event.txt"), `${round}-${index}`)),
    )
    await new Promise((resolve) => setTimeout(resolve, 10))
    await Promise.all(subscriptions.map((subscription) => subscription.unsubscribe()))

    if (round % 10 === 0 || round === rounds) sample(round)
  }

  if (globalThis.gc) {
    globalThis.gc()
    await new Promise((resolve) => setTimeout(resolve, 100))
    sample("after-gc")
  }
} finally {
  await fs.rm(root, { recursive: true, force: true })
}
