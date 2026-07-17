export * as ConfigSkillPlugin from "./skill"

import { define } from "@opencode-ai/plugin/v2/effect/plugin"
import path from "path"
import { Effect, Stream } from "effect"
import { Config } from "../../config"
import { AbsolutePath } from "../../schema"
import { SkillV2 } from "../../skill"
import { Global } from "../../global"
import { Location } from "../../location"
import { SkillDiscovery } from "../../skill/discovery"
import { allowExternalDirectories } from "../../permission/defaults"

export const Plugin = define({
  id: "opencode.config.skill",
  effect: Effect.fn(function* (ctx) {
    const config = yield* Config.Service
    const global = yield* Global.Service
    const location = yield* Location.Service
    const loaded = { entries: yield* config.entries() }
    yield* ctx.skill.transform((draft) => {
      for (const source of sources(loaded.entries, global.home, location.directory)) draft.source(source)
    })
    yield* ctx.agent.transform((draft) => {
      const permissions = allowExternalDirectories(
        sources(loaded.entries, global.home, location.directory).map((source) =>
          path.join(
            source.type === "directory" ? source.path : SkillDiscovery.cachePath(global.cache, source.url),
            "*",
          ),
        ),
      )
      for (const current of draft.list()) {
        draft.update(current.id, (agent) => agent.permissions.push(...permissions))
      }
    })
    yield* ctx.event.subscribe().pipe(
      Stream.filter((event) => event.type === "config.updated"),
      Stream.runForEach(() =>
        config.entries().pipe(
          Effect.tap((entries) => Effect.sync(() => (loaded.entries = entries))),
          Effect.andThen(ctx.skill.reload()),
          Effect.andThen(ctx.agent.reload()),
        ),
      ),
      Effect.forkScoped({ startImmediately: true }),
    )
  }),
})

function sources(entries: readonly Config.Entry[], home: string, directory: string) {
  const result: Array<SkillV2.DirectorySource | SkillV2.UrlSource> = []
  for (const entry of entries) {
    if (entry.type === "claude" || entry.type === "agents") {
      result.push(
        SkillV2.DirectorySource.make({ type: "directory", path: AbsolutePath.make(path.join(entry.path, "skills")) }),
      )
      continue
    }
    if (entry.type === "directory") {
      result.push(
        SkillV2.DirectorySource.make({ type: "directory", path: AbsolutePath.make(path.join(entry.path, "skill")) }),
        SkillV2.DirectorySource.make({ type: "directory", path: AbsolutePath.make(path.join(entry.path, "skills")) }),
      )
      continue
    }
    if (entry.type !== "document") continue
    for (const item of entry.info.skills ?? []) {
      if (URL.canParse(item) && /^(https?:)$/.test(new URL(item).protocol)) {
        result.push(SkillV2.UrlSource.make({ type: "url", url: item }))
        continue
      }
      const expanded = item.startsWith("~/") ? path.join(home, item.slice(2)) : item
      result.push(
        SkillV2.DirectorySource.make({
          type: "directory",
          path: AbsolutePath.make(path.isAbsolute(expanded) ? expanded : path.join(directory, expanded)),
        }),
      )
    }
  }
  return result
}
