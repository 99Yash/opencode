export * as ConfigReferencePlugin from "./reference"

import { define } from "@opencode-ai/plugin/v2/effect/plugin"
import path from "path"
import { Effect, Stream } from "effect"
import { Config } from "../../config"
import { ConfigReference } from "../reference"
import { Reference } from "../../reference"
import { AbsolutePath } from "../../schema"
import { Global } from "../../global"
import { Location } from "../../location"
import { allowExternalDirectories } from "../../permission/defaults"
import { Repository } from "../../repository"

export const Plugin = define({
  id: "opencode.config.reference",
  effect: Effect.fn(function* (ctx) {
    const config = yield* Config.Service
    const location = yield* Location.Service
    const global = yield* Global.Service
    const loaded = { entries: yield* config.entries() }
    yield* ctx.reference.transform((draft) => {
      for (const [name, source] of sources(loaded.entries, location.directory, global.home)) draft.add(name, source)
    })
    yield* ctx.agent.transform((draft) => {
      const permissions = allowExternalDirectories(
        Array.from(sources(loaded.entries, location.directory, global.home)).flatMap(([, source]) => {
          if (source.type === "local") return [path.join(source.path, "*")]
          const repository = Repository.parse(source.repository)
          if (!repository || !Repository.isRemote(repository)) return []
          return [path.join(Repository.cachePath(global.repos, repository), "*")]
        }),
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
          Effect.andThen(ctx.reference.reload()),
          Effect.andThen(ctx.agent.reload()),
        ),
      ),
      Effect.forkScoped({ startImmediately: true }),
    )
  }),
})

function sources(entries: readonly Config.Entry[], location: string, home: string) {
  const result = new Map<string, Reference.Source>()
  for (const doc of entries.filter((entry): entry is Config.Document => entry.type === "document")) {
    const directory = doc.path ? path.dirname(doc.path) : location
    for (const [name, entry] of Object.entries(doc.info.references ?? {})) {
      if (!validAlias(name)) continue
      const description = typeof entry === "string" ? undefined : entry.description
      const hidden = typeof entry === "string" ? undefined : entry.hidden
      result.set(
        name,
        local(entry)
          ? Reference.LocalSource.make({
              type: "local",
              path: AbsolutePath.make(localPath(directory, home, typeof entry === "string" ? entry : entry.path)),
              ...(description === undefined ? {} : { description }),
              ...(hidden === undefined ? {} : { hidden }),
            })
          : Reference.GitSource.make({
              type: "git",
              repository: typeof entry === "string" ? entry : entry.repository,
              ...(entry.branch === undefined ? {} : { branch: entry.branch }),
              ...(description === undefined ? {} : { description }),
              ...(hidden === undefined ? {} : { hidden }),
            }),
      )
    }
  }
  return result
}

function validAlias(name: string) {
  return name.length > 0 && !/[\/\s`,]/.test(name)
}

function local(entry: ConfigReference.Entry): entry is string | ConfigReference.Local {
  return typeof entry === "string"
    ? entry.startsWith(".") || entry.startsWith("/") || entry.startsWith("~")
    : "path" in entry
}

function localPath(directory: string, home: string, value: string) {
  if (value.startsWith("~/")) return path.join(home, value.slice(2))
  return path.isAbsolute(value) ? value : path.resolve(directory, value)
}
