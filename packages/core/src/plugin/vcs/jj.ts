export * as VcsJjPlugin from "./jj.js"

import path from "path"
import { Effect } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { define } from "@opencode-ai/plugin/effect/plugin"
import { FileDiff } from "@opencode-ai/schema/file-diff"
import { BranchList, FileStatus, Info, Mode } from "@opencode-ai/schema/vcs"
import { FSUtil } from "@opencode-ai/util/fs-util"
import { AppProcess } from "@opencode-ai/util/process"
import { Location } from "../../location.js"
import type { Adapter, BranchOptions, DiffOptions } from "../../vcs.js"
import { chunksByFile, countPatch, emptyPatch, MAX_TOTAL_PATCH_BYTES, PATCH_CONTEXT_LINES } from "../../vcs/patch.js"

export const Plugin = define({
  id: "opencode.vcs.jj",
  effect: Effect.fn("VcsJjPlugin")(function* (ctx) {
    const location = yield* Location.Service
    if (location.vcs?.type !== "jj" && location.vcs?.type !== "git") return

    const fs = yield* FSUtil.Service
    const metadata = yield* fs.up({ targets: [".jj"], start: location.directory, mode: "first" }).pipe(
      Effect.map((matches) => matches[0]),
      Effect.orElseSucceed(() => undefined),
    )
    if (!metadata) return
    const workspace = yield* fs
      .realPath(path.dirname(metadata))
      .pipe(Effect.orElseSucceed(() => path.dirname(metadata)))
    if (workspace !== location.project.directory) return

    const processes = yield* AppProcess.Service
    const adapter = make(processes, location.directory)

    yield* ctx.vcs.transform((draft) => {
      draft.add({
        id: "jj",
        name: "Jujutsu",
        info: () => adapter.info(),
        branches: (input) => adapter.branches({ search: input.search, limit: input.limit }),
        status: () => adapter.status(),
        diff: (input) => adapter.diff(input.mode, { context: input.context }),
      })
      if (location.vcs?.type === "git") draft.default.set("jj")
    })
  }),
})

function make(proc: AppProcess.Interface, directory: string): Adapter {
  const run = Effect.fnUntraced(
    function* (args: string[], options?: { metadata?: boolean; maxOutputBytes?: number }) {
      const result = yield* proc.run(
        ChildProcess.make(
          "jj",
          ["--color", "never", "--no-pager", ...(options?.metadata ? ["--ignore-working-copy"] : []), ...args],
          { cwd: directory, extendEnv: true, stdin: "ignore" },
        ),
        { maxOutputBytes: options?.maxOutputBytes },
      )
      return {
        exitCode: result.exitCode,
        text: () => result.stdout.toString("utf8"),
        truncated: result.stdoutTruncated || result.stderrTruncated,
      }
    },
    Effect.orElseSucceed(() => ({ exitCode: 1, text: () => "", truncated: false })),
  )

  const bookmarks = Effect.fnUntraced(function* (revision?: string) {
    const result = yield* run(
      ["bookmark", "list", ...(revision ? ["-r", revision] : []), "--sort", "name", "-T", 'name ++ "\\0"'],
      { metadata: true },
    )
    if (result.exitCode !== 0) return []
    return result.text().split("\0").filter(Boolean)
  })

  const base = Effect.fnUntraced(function* () {
    const list = yield* bookmarks()
    if (list.includes("main")) return "main"
    if (list.includes("master")) return "master"
    return (yield* bookmarks("trunk()"))[0]
  })

  const changes = Effect.fnUntraced(function* (revision: string[], options?: DiffOptions) {
    const listed = yield* run(["diff", ...revision, "-T", 'status ++ "\\t" ++ path ++ "\\0"', "."])
    if (listed.exitCode !== 0) return []
    const items = listed
      .text()
      .split("\0")
      .filter(Boolean)
      .flatMap((entry) => {
        const separator = entry.indexOf("\t")
        if (separator === -1) return []
        const code = entry.slice(0, separator)
        const file = entry.slice(separator + 1)
        if (!file) return []
        const status: FileStatus["status"] =
          code === "added" || code === "copied" ? "added" : code === "removed" ? "deleted" : "modified"
        return [{ file, status }]
      })
    if (items.length === 0) return []

    const result = yield* run(
      ["diff", ...revision, "--git", "--context", String(options?.context ?? PATCH_CONTEXT_LINES), "."],
      { metadata: true, maxOutputBytes: MAX_TOTAL_PATCH_BYTES },
    )
    const patches = chunksByFile(
      { text: result.exitCode === 0 ? result.text() : "", truncated: result.truncated },
      (index) => items[index]?.file,
    )
    return items
      .toSorted((a, b) => a.file.localeCompare(b.file))
      .map((item) => {
        const patch = patches.get(item.file) ?? emptyPatch(item.file)
        return { ...item, patch, ...countPatch(patch) } satisfies FileDiff.Info
      })
  })

  return {
    info: Effect.fn("VcsJj.info")(function* () {
      const [current, root] = yield* Effect.all([bookmarks("@"), base()], { concurrency: 2 })
      return { branch: { current: current[0], default: root } } satisfies Info
    }),
    branches: Effect.fn("VcsJj.branches")(function* (options?: BranchOptions) {
      const search = options?.search?.trim().toLowerCase()
      return (yield* bookmarks())
        .filter((bookmark) => !search || bookmark.toLowerCase().includes(search))
        .slice(0, options?.limit) satisfies BranchList
    }),
    status: Effect.fn("VcsJj.status")(function* () {
      return (yield* changes(["-r", "@"], { context: 0 })).map((item) => ({
        file: item.file,
        additions: item.additions,
        deletions: item.deletions,
        status: item.status,
      }))
    }),
    diff: Effect.fn("VcsJj.diff")(function* (mode: Mode, options?: DiffOptions) {
      if (mode === "working") return yield* changes(["-r", "@"], options)
      const root = yield* base()
      if (!root) return []
      return yield* changes(["--from", `fork_point(${root} | @)`], options)
    }),
  }
}
