import { mkdir, readdir, unlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

export async function createVoiceTrace() {
  const directory = join(tmpdir(), "opencode-voice")
  await mkdir(directory, { recursive: true })
  const stale = (await readdir(directory))
    .filter((name) => name.endsWith(".jsonl"))
    .sort()
    .slice(0, -20)
  await Promise.allSettled(stale.map((name) => unlink(join(directory, name))))
  const path = join(directory, `${new Date().toISOString().replaceAll(":", "-")}-${process.pid}.jsonl`)
  const writer = Bun.file(path).writer()
  const flush = setInterval(() => void writer.flush(), 250)
  let bytes = 0
  flush.unref()

  return {
    path,
    write(event: string, data: Record<string, unknown> = {}) {
      if (bytes >= 10_000_000) return
      const line = `${JSON.stringify({ time: Date.now(), event, ...data })}\n`
      bytes += Buffer.byteLength(line)
      void writer.write(line)
    },
    async close() {
      clearInterval(flush)
      await writer.end()
    },
  }
}
