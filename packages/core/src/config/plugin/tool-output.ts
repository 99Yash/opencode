export * as ConfigToolOutputPlugin from "./tool-output.js"

import { define } from "@opencode-ai/plugin/effect/plugin"
import type { Entry } from "@opencode-ai/schema/config"
import { Effect, Stream } from "effect"
import { Config } from "../../config.js"
import { ToolOutput } from "../../tool-output.js"

export const Plugin = define({
  id: "opencode.config.tool-output",
  effect: Effect.fn(function* (ctx) {
    const config = yield* Config.Service
    const output = yield* ToolOutput.Service
    const loaded = { entries: [] as Entry[] }
    yield* ctx.event
      .subscribe()
      .pipe(
        Stream.filter((event) => event.type === "config.updated"),
        Stream.runForEach(() =>
          config.entries().pipe(
            Effect.tap((entries) => Effect.sync(() => (loaded.entries = entries))),
            Effect.andThen(output.reload()),
          ),
        ),
        Effect.forkScoped({ startImmediately: true }),
      )
    loaded.entries = yield* config.entries()
    yield* output.transform((draft) => {
      const configured = Config.latest(loaded.entries, "tool_output")
      if (!configured) return
      draft.update((policy) => {
        if (configured.max_lines !== undefined) policy.maxLines = configured.max_lines
        if (configured.max_bytes !== undefined) policy.maxBytes = configured.max_bytes
      })
    })
  }),
})
