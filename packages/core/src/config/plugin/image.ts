export * as ConfigImagePlugin from "./image.js"

import { define } from "@opencode-ai/plugin/effect/plugin"
import type { Entry } from "@opencode-ai/schema/config"
import { Effect, Stream } from "effect"
import { Config } from "../../config.js"
import { Image } from "../../image.js"

export const Plugin = define({
  id: "opencode.config.image",
  effect: Effect.fn(function* (ctx) {
    const config = yield* Config.Service
    const image = yield* Image.Service
    const loaded = { entries: [] as Entry[] }
    yield* ctx.event
      .subscribe()
      .pipe(
        Stream.filter((event) => event.type === "config.updated"),
        Stream.runForEach(() =>
          config.entries().pipe(
            Effect.tap((entries) => Effect.sync(() => (loaded.entries = entries))),
            Effect.andThen(image.reload()),
          ),
        ),
        Effect.forkScoped({ startImmediately: true }),
      )
    loaded.entries = yield* config.entries()
    yield* image.transform((draft) => {
      for (const entry of loaded.entries) {
        if (entry.type !== "document" || !entry.info.media?.image) continue
        draft.update((policy) => {
          const configured = entry.info.media?.image
          if (!configured) return
          if (configured.auto_resize !== undefined) policy.autoResize = configured.auto_resize
          if (configured.max_width !== undefined) policy.maxWidth = configured.max_width
          if (configured.max_height !== undefined) policy.maxHeight = configured.max_height
          if (configured.max_base64_bytes !== undefined) policy.maxBase64Bytes = configured.max_base64_bytes
        })
      }
    })
  }),
})
