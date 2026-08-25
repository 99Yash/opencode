export * as ProjectJj from "./jj.js"

import path from "path"
import { Effect } from "effect"
import { FSUtil } from "@opencode-ai/util/fs-util"
import type { Git } from "../git.js"
import { AbsolutePath } from "../schema.js"

export const discover = Effect.fn("ProjectJj.discover")(function* (fs: FSUtil.Interface, input: AbsolutePath) {
  const metadata = yield* fs.up({ targets: [".jj"], start: input, mode: "first" }).pipe(
    Effect.map((matches) => matches[0]),
    Effect.orElseSucceed(() => undefined),
  )
  if (!metadata) return undefined

  const reference = path.join(metadata, "repo")
  const direct = yield* fs.isDir(reference)
  const pointer = direct ? undefined : yield* fs.readFileString(reference).pipe(Effect.orElseSucceed(() => undefined))
  if (!direct && !pointer?.trim()) return undefined

  const store = yield* fs.realPath(pointer ? path.resolve(metadata, pointer.trim()) : reference).pipe(
    Effect.map((value) => AbsolutePath.make(value)),
    Effect.orElseSucceed(() => undefined),
  )
  if (!store || !(yield* fs.isDir(store))) return undefined

  const directory = yield* fs.realPath(path.dirname(metadata)).pipe(
    Effect.map((value) => AbsolutePath.make(value)),
    Effect.orElseSucceed(() => undefined),
  )
  if (!directory) return undefined

  return { directory, store, canonical: AbsolutePath.make(path.dirname(path.dirname(store))) }
})

export const repositories = Effect.fn("ProjectJj.repositories")(function* (
  fs: FSUtil.Interface,
  git: Git.Interface,
  input: AbsolutePath,
) {
  const [repository, workspace] = yield* Effect.all([git.repo.discover(input), discover(fs, input)], {
    concurrency: 2,
  })
  const jj =
    workspace &&
    repository &&
    repository.worktree !== workspace.directory &&
    FSUtil.contains(workspace.directory, repository.worktree)
      ? undefined
      : workspace
  const backing =
    jj && (!repository || repository.worktree !== jj.directory) ? yield* git.repo.discover(jj.canonical) : repository
  return {
    git: jj && backing?.worktree !== jj.canonical && backing?.worktree !== jj.directory ? undefined : backing,
    jj,
  }
})
