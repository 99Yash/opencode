export * as ConfigSkillPlugin from "./skill.js"

import { define } from "@opencode-ai/plugin/effect/plugin"
import type { Entry } from "@opencode-ai/schema/config"
import { Global } from "@opencode-ai/util/global"
import path from "path"
import { Effect, Stream } from "effect"
import { Config } from "../../config.js"
import { Location } from "../../location.js"
import { AbsolutePath } from "../../schema.js"
import { Skill } from "../../skill.js"
import { SkillSourceObserver } from "../../skill/source-observer.js"

type Source = Skill.DirectorySource | Skill.UrlSource

export const Plugin = define({
  id: "opencode.config.skill",
  effect: Effect.fn(function* (ctx) {
    const config = yield* Config.Service
    const global = yield* Global.Service
    const location = yield* Location.Service
    const loaded: { entries: Entry[] } = {
      entries: yield* config.entries(),
    }

    const sources = () => {
      const result: Source[] = []
      const add = (source: Source) => {
        if (result.some((item) => Skill.Source.equals(item, source))) return
        result.push(source)
      }
      const claude = loaded.entries.flatMap((entry) => (entry.type === "claude" ? [entry.path] : []))
      const agents = loaded.entries.flatMap((entry) => (entry.type === "agents" ? [entry.path] : []))
      const directories = loaded.entries.flatMap((entry) => (entry.type === "directory" ? [entry.path] : []))
      const items = loaded.entries.flatMap((entry) => (entry.type === "document" ? (entry.info.skills ?? []) : []))
      for (const directory of [...claude, ...agents]) {
        add(Skill.DirectorySource.make({ type: "directory", path: AbsolutePath.make(path.join(directory, "skills")) }))
      }
      for (const directory of directories) {
        add(Skill.DirectorySource.make({ type: "directory", path: AbsolutePath.make(path.join(directory, "skill")) }))
        add(Skill.DirectorySource.make({ type: "directory", path: AbsolutePath.make(path.join(directory, "skills")) }))
      }
      for (const item of items) {
        if (URL.canParse(item) && /^(https?:)$/.test(new URL(item).protocol)) {
          add(Skill.UrlSource.make({ type: "url", url: item }))
          continue
        }
        const expanded = item.startsWith("~/") ? path.join(global.home, item.slice(2)) : item
        add(
          Skill.DirectorySource.make({
            type: "directory",
            path: AbsolutePath.make(path.isAbsolute(expanded) ? expanded : path.join(location.directory, expanded)),
          }),
        )
      }
      return result
    }

    const observer = yield* SkillSourceObserver.make({ sources, onChange: ctx.skill.reload })
    yield* ctx.skill.transform((draft) => {
      for (const skill of observer.list()) draft.add(skill)
    })
    yield* ctx.event.subscribe().pipe(
      Stream.filter((event) => event.type === "config.updated"),
      Stream.runForEach(() =>
        config.entries().pipe(
          Effect.tap((entries) => Effect.sync(() => (loaded.entries = entries))),
          Effect.andThen(observer.refresh()),
          Effect.andThen(ctx.skill.reload()),
        ),
      ),
      Effect.forkScoped({ startImmediately: true }),
    )
  }),
})
