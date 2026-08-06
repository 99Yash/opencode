import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { make } from "effect/unstable/process/ChildProcessSpawner"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { FileSystem } from "@opencode-ai/core/filesystem"
import { Location } from "@opencode-ai/core/location"
import { Project } from "@opencode-ai/core/project"
import { AbsolutePath, RelativePath } from "@opencode-ai/core/schema"
import { Workspace } from "@opencode-ai/core/workspace"
import { WorkspaceEnvironment } from "@opencode-ai/core/workspace/environment"
import { testEffect } from "./lib/effect"

const workspaceID = Workspace.ID.make("wrk_test")
const ROOT = "/workspace"

/** In-memory environment: file paths to contents, no symlinks. */
const memoryEnvironment = (files: Record<string, string>) => {
  const encoder = new TextEncoder()
  const store = new Map(Object.entries(files).map(([key, value]) => [key, Uint8Array.from(encoder.encode(value))]))
  const isDirectory = (path: string) =>
    path === ROOT || Array.from(store.keys()).some((key) => key.startsWith(path + "/"))
  const exists = (path: string) => store.has(path) || isDirectory(path)
  const fail = (operation: string, path: string) =>
    Effect.fail(new WorkspaceEnvironment.NotFoundError({ path })).pipe(
      Effect.annotateLogs({ operation }),
    ) as Effect.Effect<never, WorkspaceEnvironment.NotFoundError>
  return WorkspaceEnvironment.make({
    platform: "linux",
    directory: ROOT,
    files: {
      stat: (path) =>
        store.has(path)
          ? Effect.succeed({ type: "File" as const })
          : isDirectory(path)
            ? Effect.succeed({ type: "Directory" as const })
            : fail("stat", path),
      realPath: (path) => (exists(path) ? Effect.succeed(path) : fail("realPath", path)),
      read: (path) => {
        const content = store.get(path)
        return content ? Effect.succeed(content) : fail("read", path)
      },
      list: (path) => {
        if (!isDirectory(path)) return fail("list", path)
        const names = new Map<string, "file" | "directory">()
        for (const key of store.keys()) {
          if (!key.startsWith(path + "/")) continue
          const rest = key.slice(path.length + 1)
          const [head] = rest.split("/")
          if (head) names.set(head, rest.includes("/") ? "directory" : "file")
        }
        return Effect.succeed(Array.from(names, ([name, type]) => ({ name, type })))
      },
      write: (path, content) => Effect.sync(() => void store.set(path, Uint8Array.from(content))),
    },
    process: make(() => Effect.die(new Error("no processes in the memory environment"))),
    shell: WorkspaceEnvironment.linuxShell,
  })
}

const environment = memoryEnvironment({
  "/workspace/README.md": "# hello\n",
  "/workspace/src/index.ts": "export {}\n",
  "/workspace/src/util/deep.ts": "export const deep = 1\n",
})

const locationLayer = Layer.succeed(
  Location.Service,
  Location.Service.of({
    directory: AbsolutePath.make(ROOT),
    workspaceID,
    project: {
      id: Project.ID.global,
      directory: AbsolutePath.make(ROOT),
      canonical: AbsolutePath.make("/"),
    },
  }),
)

const it = testEffect(
  AppNodeBuilder.build(FileSystem.hostedNode, [
    [WorkspaceEnvironment.node, Layer.succeed(WorkspaceEnvironment.Service, environment)],
    [Location.node, locationLayer],
  ]),
)

describe("hosted FileSystem", () => {
  it.effect("reads a file through the environment", () =>
    Effect.gen(function* () {
      const filesystem = yield* FileSystem.Service
      const result = yield* filesystem.read({ path: RelativePath.make("README.md") })
      expect(new TextDecoder().decode(result.content)).toBe("# hello\n")
      expect(result.mime).toBe("text/markdown")
    }),
  )

  it.effect("lists directories before files with posix separators", () =>
    Effect.gen(function* () {
      const filesystem = yield* FileSystem.Service
      const entries = yield* filesystem.list({ path: RelativePath.make("src") })
      expect(entries.map((entry) => String(entry.path))).toEqual(["src/util/", "src/index.ts"])
    }),
  )

  it.effect("lists the root when no path is given", () =>
    Effect.gen(function* () {
      const filesystem = yield* FileSystem.Service
      const entries = yield* filesystem.list()
      expect(entries.map((entry) => String(entry.path))).toEqual(["src/", "README.md"])
    }),
  )

  it.effect("refuses paths that escape the workspace", () =>
    Effect.gen(function* () {
      const filesystem = yield* FileSystem.Service
      const exit = yield* filesystem.read({ path: RelativePath.make("../etc/passwd") }).pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
    }),
  )
})
