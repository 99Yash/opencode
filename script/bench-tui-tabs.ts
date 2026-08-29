import { $ } from "bun"
import { appendFileSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { Effect, Schema } from "effect"
import { Llm, OpenCodeDriver, type Ui } from "opencode-drive"
import { Session } from "../packages/schema/src/session"
import { SessionMessage } from "../packages/schema/src/session-message"

const run = process.env.PERF_RUN
if (!run) throw new Error("PERF_RUN must identify a new experiment")
const target = process.env.PERF_TARGET ?? process.cwd()
const output = path.join(process.env.PERF_OUTPUT ?? path.join(target, ".cache", "tui-switch"), run)
await mkdir(path.dirname(output), { recursive: true })
await mkdir(output, { recursive: false })
const revision = (await $`git -C ${target} rev-parse HEAD`.quiet().text()).trim()
await Bun.write(
  path.join(output, "changes.patch"),
  await $`git -C ${target} diff HEAD -- packages/tui/src packages/client/src/solid`.quiet().text(),
)
const samples: { name: string; sample: number; actionMs: number; visibleMs: number }[] = []
const fixtures = [
  { name: "SHORT", count: 20, bytes: 256 },
  { name: "LONG", count: 2000, bytes: 256 },
  { name: "LARGE", count: 20, bytes: 32768 },
]

const measure = (ui: Ui, name: string, sample: number, action: Effect.Effect<unknown, unknown>, marker: string) =>
  Effect.gen(function* () {
    const start = performance.now()
    yield* action
    const actionMs = performance.now() - start
    yield* ui.waitFor(marker, { timeout: 30_000, interval: 20 })
    const result = { name, sample, actionMs, visibleMs: performance.now() - start }
    samples.push(result)
    appendFileSync(path.join(output, "samples.jsonl"), JSON.stringify(result) + "\n")
    console.error(JSON.stringify(result))
    // Fixed pacing is outside the timing window; the marker above determines readiness.
    yield* Effect.sleep(150)
  })

export default OpenCodeDriver.useReport(
  {
    keepArtifacts: true,
    project: {
      git: true,
      files: {
        "README.md": "# Synthetic tab-switch benchmark\n",
        ".opencode/cli.json": JSON.stringify({ debug: { devtools: false } }),
      },
    },
    config: { autoupdate: false },
    tui: { viewport: { cols: 120, rows: 40 } },
    opencode: { dev: target },
  },
  (driver) =>
    Effect.gen(function* () {
      yield* driver.tui.close()
      const template = yield* driver.opencode.session.create({ title: "Template" })
      const model = (yield* driver.opencode.model.default({ location: template.location })).data
      if (!model) return yield* Effect.fail(new Error("Simulated model unavailable"))
      const agent = (yield* driver.opencode.agent.list({ location: template.location })).data.find(
        (item) => item.id === "build",
      )
      if (!agent) return yield* Effect.fail(new Error("Build agent unavailable"))
      const seeded = yield* Effect.forEach(fixtures, (fixture) =>
        Effect.gen(function* () {
          const messages = Array.from({ length: fixture.count }, (_, index) => {
            const created = 1_780_000_000_000 + index * 10_000
            const marker =
              index === 0
                ? `FIRST_${fixture.name}`
                : index === fixture.count - 1
                  ? `END_${fixture.name}`
                  : `ROW_${index}`
            const id = SessionMessage.ID.create()
            if (index % 2 === 0)
              return Schema.decodeUnknownSync(SessionMessage.Info)({
                id,
                type: "user",
                time: { created },
                text: `${marker} Please inspect the parser and explain the next small implementation step with a test.`,
              })
            const block =
              process.env.PERF_CONTENT === "prose"
                ? "The parser validates input before constructing the result. Keep this boundary explicit and add a focused regression test. "
                : "The parser validates input before constructing the result. Keep this boundary explicit and add a focused regression test.\n\n```ts\nconst value = parse(source)\nexpect(value.ok).toBe(true)\n```\n\n"
            const tail = `\n\n${marker}`
            return Schema.decodeUnknownSync(SessionMessage.Info)({
              id,
              type: "assistant",
              agent: agent.id,
              model: { providerID: model.providerID, id: model.id },
              finish: "stop",
              time: { created, completed: created + 400 },
              content: [
                ...(index % 10 === 5
                  ? [
                      {
                        type: "tool",
                        id: `call_${index}`,
                        name: "read",
                        state: {
                          status: "completed",
                          input: { path: "src/parser.ts" },
                          content: [
                            {
                              type: "text",
                              text: "1: export const parse = (source: string) => ({ ok: true, source })",
                            },
                          ],
                        },
                        time: { created, completed: created + 100 },
                      },
                    ]
                  : []),
                {
                  type: "text",
                  text:
                    block.repeat(Math.ceil(fixture.bytes / block.length)).slice(0, fixture.bytes - tail.length) + tail,
                },
              ],
            })
          })
          return yield* driver.opencode.session.import({
            info: {
              ...template,
              id: Session.ID.create(),
              title: `Perf ${fixture.name}`,
              agent: agent.id,
              model: { providerID: model.providerID, id: model.id },
            },
            messages,
          })
        }),
      )
      yield* driver.opencode.session.remove({ sessionID: template.id })
      const tui = yield* driver.tuis.launch("measured", { viewport: { cols: 120, rows: 40 } })
      const ui = tui.ui
      yield* Effect.forEach(seeded, (session, index) =>
        Effect.gen(function* () {
          yield* ui.press("o", { ctrl: true })
          yield* ui.waitFor("Search sessions and")
          yield* ui.type(session.title ?? "")
          yield* ui.waitFor(session.title ?? "")
          yield* measure(ui, `cold.${fixtures[index].name}`, 0, ui.enter(), `END_${fixtures[index].name}`)
        }),
      )
      const select = (index: number) => ui.press(String(index + 1), { ctrl: true })
      yield* Effect.forEach(["latest20", "retained2000", "head2000", "large"], (phase) =>
        Effect.gen(function* () {
          if (phase === "retained2000") {
            yield* select(1)
            yield* measure(ui, "history.first", 0, ui.press("g", { ctrl: true }), "FIRST_LONG")
            yield* measure(ui, "history.latest", 0, ui.press("g", { ctrl: true, meta: true }), "END_LONG")
          }
          if (phase === "head2000") {
            yield* select(1)
            yield* ui.press("g", { ctrl: true })
            yield* ui.waitFor("FIRST_LONG")
          }
          const index = phase === "large" ? 2 : 1
          yield* Effect.forEach(
            Array.from({ length: 9 }, (_, index) => index),
            (sample) =>
              Effect.gen(function* () {
                yield* measure(ui, `${phase}.SHORT`, sample, select(0), "END_SHORT")
                yield* measure(
                  ui,
                  `${phase}.${fixtures[index].name}`,
                  sample,
                  select(index),
                  phase === "head2000" ? "FIRST_LONG" : `END_${fixtures[index].name}`,
                )
              }),
          )
          const frame = yield* ui.capture()
          yield* Effect.promise(() => Bun.write(path.join(output, `${phase}.frame.json`), JSON.stringify(frame)))
          if (phase === "head2000") {
            yield* ui.press("g", { ctrl: true, meta: true })
            yield* ui.waitFor("END_LONG")
          }
        }),
      )
      yield* ui.screenshot("measured-large")
      yield* select(0)
      yield* driver.llm.queue(
        Llm.text("```text\ninitial", { delay: 10, chunkSize: 5 }),
        Llm.text(" final\n```\n\nSTREAM_DONE", { delay: 10, chunkSize: 5 }),
      )
      yield* ui.submit("Synthetic streaming completion check")
      yield* ui.waitFor("STREAM_DONE", { timeout: 30_000 })
      yield* ui.waitFor("initial final")
      yield* driver.opencode.session.wait({ sessionID: seeded[0].id })
      const final = yield* driver.opencode.message.list({ sessionID: seeded[0].id, limit: 1, order: "desc" })
      if (final.data[0]?.type !== "assistant" || !final.data[0].time.completed)
        return yield* Effect.fail(new Error("Streaming completion was not projected"))
      yield* ui.screenshot("streaming-completed")
      const summary = [...new Set(samples.filter((sample) => sample.sample > 0).map((sample) => sample.name))].map(
        (name) => {
          const values = samples
            .filter((sample) => sample.name === name && sample.sample > 0)
            .map((sample) => sample.actionMs)
            .toSorted((a, b) => a - b)
          return {
            name,
            n: values.length,
            medianMs: (values[3] + values[4]) / 2,
            minMs: values[0],
            maxMs: values.at(-1),
          }
        },
      )
      yield* Effect.promise(() =>
        Bun.write(
          path.join(output, "results.json"),
          JSON.stringify(
            { run, target, revision, fixtures, content: process.env.PERF_CONTENT ?? "markdown", samples, summary },
            null,
            2,
          ),
        ),
      )
      console.table(summary)
      return summary
    }),
).pipe(
  Effect.tap((report) =>
    Effect.promise(() => Bun.write(path.join(output, "report.json"), JSON.stringify(report, null, 2))),
  ),
)
