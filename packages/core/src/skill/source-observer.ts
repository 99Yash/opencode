export * as SkillSourceObserver from "./source-observer.js"

import { FSUtil } from "@opencode-ai/util/fs-util"
import path from "path"
import { Effect, FiberMap, PubSub, Semaphore, Stream } from "effect"
import { Watcher } from "../filesystem/watcher.js"
import { AbsolutePath } from "../schema.js"
import { Skill } from "../skill.js"
import { SkillDiscovery } from "./discovery.js"
import { SkillFile } from "../config/plugin/skill-file.js"

type Source = Skill.DirectorySource | Skill.UrlSource

// Sources are read inside each rescan; the caller owns their interpretation and
// publishes domain updates after filesystem-triggered snapshots are committed.
export const make = Effect.fn("SkillSourceObserver.make")(function* (input: {
  readonly sources: () => readonly Source[]
  readonly onChange: () => Effect.Effect<void>
}) {
  const discovery = yield* SkillDiscovery.Service
  const fs = yield* FSUtil.Service
  const watcher = yield* Watcher.Service
  const loaded: { skills: Skill.Info[] } = { skills: [] }
  const watches = yield* FiberMap.make<string>()
  const changes = yield* PubSub.sliding<string>(1)
  const lock = Semaphore.makeUnsafe(1)

  const watch = Effect.fn("SkillSourceObserver.watch")(function* (directory: string, type: Watcher.WatchInput["type"]) {
    const target = path.resolve(directory)
    const updates = yield* watcher.subscribe({ path: target, type })
    yield* FiberMap.run(
      watches,
      `${type}:${target}`,
      updates.pipe(Stream.runForEach((update) => PubSub.publish(changes, update.path).pipe(Effect.asVoid))),
      { onlyIfMissing: true, startImmediately: true },
    )
  })

  function firstMissing(target: string): Effect.Effect<string | undefined> {
    const parent = path.dirname(target)
    if (parent === target) return Effect.undefined
    return fs.isDir(parent).pipe(Effect.flatMap((exists) => (exists ? Effect.succeed(target) : firstMissing(parent))))
  }

  const watchDirectory: (directory: string) => Effect.Effect<string[]> = Effect.fn(
    "SkillSourceObserver.watchDirectory",
  )(function* (directory: string) {
    const target = path.resolve(directory)
    const resolved = yield* fs.realPath(directory).pipe(Effect.orElseSucceed(() => undefined))
    if (resolved) {
      yield* watch(resolved, "directory")
      if (resolved !== target) yield* watch(target, "file")
      return resolved === target ? [target] : [target, resolved]
    }
    const missing = yield* firstMissing(target)
    if (missing) yield* watch(missing, "file")
    if (
      yield* fs.realPath(directory).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      )
    ) {
      if (missing) yield* FiberMap.remove(watches, `file:${path.resolve(missing)}`)
      return yield* watchDirectory(directory)
    }
    return [target]
  })

  const load = Effect.fn("SkillSourceObserver.load")(function* (source: Source) {
    const directories =
      source.type === "directory"
        ? [source.path]
        : yield* discovery.pull(source.url).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("failed to load skill source", {
                source: Skill.Source.key(source),
                cause,
              }).pipe(Effect.as([] as AbsolutePath[])),
            ),
          )
    const roots = (yield* Effect.forEach(directories, watchDirectory)).flat()
    const skills: Skill.Info[] = []
    for (const directory of directories) {
      const files = yield* fs
        .scan("{*.md,**/SKILL.md}", { cwd: directory, absolute: true, include: "file", symlink: true, dot: true })
        .pipe(Effect.orElseSucceed(() => [] as string[]))
      for (const filepath of files.toSorted()) {
        const resolved = yield* fs.realPath(filepath).pipe(Effect.orElseSucceed(() => filepath))
        if (!roots.some((root) => FSUtil.contains(root, resolved))) yield* watch(path.dirname(resolved), "directory")
        const content = yield* fs.readFileStringSafe(filepath).pipe(Effect.orElseSucceed(() => undefined))
        if (!content) continue
        const parsed = SkillFile.parse(directory, filepath, content)
        if (parsed._tag === "Skipped") {
          yield* Effect.logDebug("skill file skipped", {
            filepath,
            reason: parsed.reason,
            ...(parsed.reason === "frontmatter" ? { issue: parsed.issue } : {}),
          })
          continue
        }
        skills.push(parsed.skill)
      }
    }
    yield* Effect.logDebug("skill source loaded", {
      source: Skill.Source.key(source),
      type: source.type,
      directories,
      skills: skills.map((skill) => skill.id),
    })
    return skills
  })

  const refresh = Effect.fn("SkillSourceObserver.refresh")(function* (file?: string) {
    yield* lock.withPermit(
      Effect.gen(function* () {
        yield* FiberMap.clear(watches)
        const skills = new Map<Skill.ID, Skill.Info>()
        const current = input.sources()
        for (const source of current) {
          for (const skill of yield* load(source)) skills.set(skill.id, skill)
        }
        loaded.skills = Array.from(skills.values())
        if (file) {
          yield* Effect.logInfo("skills rescanned", {
            file,
            sources: current.map(Skill.Source.key),
            skills: loaded.skills.map((skill) => skill.id),
          })
        }
      }),
    )
  })

  yield* Stream.fromPubSub(changes).pipe(
    Stream.runForEach((file) => refresh(file).pipe(Effect.andThen(() => input.onChange()))),
    Effect.forkScoped({ startImmediately: true }),
  )
  yield* refresh()
  return {
    list: (): readonly Skill.Info[] => loaded.skills,
    refresh: () => refresh(),
  }
})
