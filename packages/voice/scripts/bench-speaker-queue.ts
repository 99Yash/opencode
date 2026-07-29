import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const directory = await mkdtemp(join(tmpdir(), "opencode-voice-bench-"))
const binary = join(directory, "speaker-queue")
const source = Bun.fileURLToPath(new URL("../src/duplex-audio.swift", import.meta.url))
const compile = Bun.spawn(["swiftc", "-O", "-D", "QUEUE_BENCHMARK", source, "-o", binary], {
  stdout: "ignore",
  stderr: "pipe",
})
if ((await compile.exited) !== 0) {
  console.error(await new Response(compile.stderr).text())
  await rm(directory, { recursive: true })
  process.exit(1)
}

const runs: Array<Record<string, number>> = []
for (let index = 0; index < 8; index++) {
  const process = Bun.spawn([binary], { stdout: "pipe", stderr: "inherit" })
  const output = await new Response(process.stdout).text()
  if ((await process.exited) !== 0) throw new Error(`benchmark run ${index + 1} failed`)
  if (index === 0) continue
  runs.push(
    Object.fromEntries(
      output
        .split("\n")
        .filter((line) => line.startsWith("METRIC "))
        .map((line) => {
          const [name, value] = line.slice(7).split("=")
          return [name!, Number(value)]
        }),
    ),
  )
}
await rm(directory, { recursive: true })

for (const name of ["speaker_queue_median_ns", "speaker_queue_p99_ns", "speaker_queue_worst_ns"]) {
  const values = runs.map((run) => run[name]!).sort((a, b) => a - b)
  const median = values[Math.floor(values.length / 2)]!
  console.log(`${name}: median=${median} range=${values[0]}..${values.at(-1)}`)
  console.log(`METRIC ${name}=${median}`)
}
