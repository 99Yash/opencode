import { Effect } from "effect"
import { make } from "effect/unstable/process/ChildProcessSpawner"
import { WorkspaceEnvironment } from "@opencode-ai/core/workspace/environment"

export const ROOT = "/workspace"

export interface MemoryEnvironment {
  readonly environment: WorkspaceEnvironment.Interface
  /** Live view of stored file contents by absolute path. */
  readonly contents: (path: string) => string | undefined
  readonly paths: () => string[]
}

/**
 * In-memory workspace environment rooted at /workspace: file paths to
 * contents, directories implied by keys, no symlinks, no processes.
 */
export const memoryEnvironment = (files: Record<string, string>): MemoryEnvironment => {
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  const store = new Map(Object.entries(files).map(([key, value]) => [key, Uint8Array.from(encoder.encode(value))]))
  const isDirectory = (path: string) =>
    path === ROOT || Array.from(store.keys()).some((key) => key.startsWith(path + "/"))
  const exists = (path: string) => store.has(path) || isDirectory(path)
  const fail = (path: string) => Effect.fail(new WorkspaceEnvironment.NotFoundError({ path }))
  const environment = WorkspaceEnvironment.make({
    platform: "linux",
    directory: ROOT,
    files: {
      stat: (path) =>
        store.has(path)
          ? Effect.succeed({ type: "File" as const })
          : isDirectory(path)
            ? Effect.succeed({ type: "Directory" as const })
            : fail(path),
      realPath: (path) => (exists(path) ? Effect.succeed(path) : fail(path)),
      read: (path) => {
        const content = store.get(path)
        return content ? Effect.succeed(content) : fail(path)
      },
      list: (path) => {
        if (!isDirectory(path)) return fail(path)
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
  return {
    environment,
    contents: (path) => {
      const stored = store.get(path)
      return stored ? decoder.decode(stored) : undefined
    },
    paths: () => Array.from(store.keys()).sort(),
  }
}
