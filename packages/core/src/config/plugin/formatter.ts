export * as ConfigFormatterPlugin from "./formatter.js"

import { define } from "@opencode-ai/plugin/effect/plugin"
import type { Entry } from "@opencode-ai/schema/config"
import { Effect, Stream } from "effect"
import { Config } from "../../config.js"
import { Formatter } from "../../formatter.js"

export const Plugin = define({
  id: "opencode.config.formatter",
  effect: Effect.fn(function* (ctx) {
    const config = yield* Config.Service
    const formatter = yield* Formatter.Service
    const loaded = { entries: [] as Entry[] }
    yield* ctx.event
      .subscribe()
      .pipe(
        Stream.filter((event) => event.type === "config.updated"),
        Stream.runForEach(() =>
          config.entries().pipe(
            Effect.tap((entries) => Effect.sync(() => (loaded.entries = entries))),
            Effect.andThen(formatter.reload()),
          ),
        ),
        Effect.forkScoped({ startImmediately: true }),
      )
    loaded.entries = yield* config.entries()
    yield* formatter.transform((draft) => {
      const configured = Config.latest(loaded.entries, "formatter")
      if (configured === false) {
        draft.clear()
        return
      }
      if (configured === undefined) {
        for (const item of draft.list()) if (item.builtIn) draft.remove(item.name)
        return
      }
      if (configured === true) return
      for (const [name, entry] of Object.entries(configured)) {
        if (entry.disabled) {
          draft.remove(name)
          continue
        }
        const current = draft.get(name)
        draft.set(name, {
          name,
          extensions: entry.extensions ?? current?.extensions ?? [],
          environment: { ...current?.environment, ...entry.environment },
          enabled:
            current && !entry.command ? current.enabled : Effect.succeed(entry.command ? [...entry.command] : false),
        })
      }
    })
  }),
})
