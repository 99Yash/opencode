export * as ConfigSourceWatch from "./source-watch.js"

import path from "path"
import type { Entry } from "@opencode-ai/schema/config"
import { FSUtil } from "@opencode-ai/util/fs-util"
import { Effect, FiberMap, PubSub, Stream } from "effect"
import { Watcher } from "../filesystem/watcher.js"

/** Scoped root subscriptions for the source directories a config plugin reads. */
export const make = Effect.fn("ConfigSourceWatch.make")(function* (directories: readonly string[]) {
  const watcher = yield* Watcher.Service
  const watches = yield* FiberMap.make<string>()
  const changes = yield* PubSub.sliding<void>(1)
  // Match Config's ignores so equivalent subscriptions share an OS watch.
  const ignore = ["node_modules", ".git", "**/{node_modules,.git}/**"]

  return {
    changes: Stream.fromPubSub(changes),
    reconcile: Effect.fn("ConfigSourceWatch.reconcile")(function* (entries: readonly Entry[]) {
      const roots = new Set(entries.flatMap((entry) => (entry.type === "directory" ? [path.resolve(entry.path)] : [])))
      yield* Effect.forEach(
        Array.from(watches).filter(([root]) => !roots.has(root)),
        ([root]) => FiberMap.remove(watches, root),
        { discard: true },
      )
      yield* Effect.forEach(
        roots,
        Effect.fnUntraced(function* (root) {
          if (yield* FiberMap.has(watches, root)) return
          // Watch the root even before a source subdirectory exists. Directory
          // rename events have no suffix and must trigger the same rebuild.
          const updates = yield* watcher.subscribe({ path: root, type: "directory", ignore })
          yield* FiberMap.run(
            watches,
            root,
            updates.pipe(
              Stream.filter((update) =>
                directories.some((name) => FSUtil.contains(path.join(root, name), update.path)),
              ),
              Stream.runForEach(() => PubSub.publish(changes, undefined)),
            ),
            { onlyIfMissing: true, startImmediately: true },
          )
        }),
        { discard: true },
      )
    }),
  }
})
