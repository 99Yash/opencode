import { describe, expect } from "bun:test"
import { Config } from "@opencode-ai/core/config"
import { ConfigImagePlugin } from "@opencode-ai/core/config/plugin/image"
import { Image } from "@opencode-ai/core/image"
import { Document, Info } from "@opencode-ai/schema/config"
import { ConfigMedia } from "@opencode-ai/schema/config/media"
import { Effect, Layer } from "effect"
import { host } from "../plugin/host"
import { it } from "../lib/effect"

describe("ConfigImagePlugin.Plugin", () => {
  it.live("materializes image policy from config", () =>
    Effect.gen(function* () {
      const policy = {
        autoResize: true,
        maxWidth: 2_000,
        maxHeight: 2_000,
        maxBase64Bytes: 5 * 1024 * 1024,
      }
      const image = Image.Service.of({
        normalize: () => Effect.die("unused image.normalize"),
        reload: () => Effect.void,
        transform: (callback) =>
          Effect.sync(() => {
            callback({ update: (update) => update(policy) })
            return { dispose: Effect.void }
          }),
      })
      yield* ConfigImagePlugin.Plugin.effect(host()).pipe(
        Effect.provideService(Image.Service, image),
        Effect.provide(
          Config.testLayer([
            new Document({
              type: "document",
              info: new Info({
                media: new ConfigMedia.Info({
                  image: new ConfigMedia.Image({
                    auto_resize: false,
                    max_width: 1_000,
                    max_height: 800,
                    max_base64_bytes: 123_456,
                  }),
                }),
              }),
            }),
          ]),
        ),
      )

      expect(policy).toEqual({
        autoResize: false,
        maxWidth: 1_000,
        maxHeight: 800,
        maxBase64Bytes: 123_456,
      })
    }),
  )
})
