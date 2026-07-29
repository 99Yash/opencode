import { mkdir, readdir, rename, rm } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { Option, Schema } from "effect"
import { OpenCodeNotification } from "./opencode-notification"
import { promptKey, type PromptHandle } from "./prompt-handle"

export type CompletionHandle = PromptHandle
export type StoredCompletion =
  | { readonly status: "admitting"; readonly handle: CompletionHandle; readonly text: string }
  | { readonly status: "pending"; readonly handle: CompletionHandle }
  | {
      readonly status: "completed"
      readonly handle: CompletionHandle
      readonly notification: OpenCodeNotification
    }

const CompletionHandle = Schema.Struct({ sessionID: Schema.String, promptID: Schema.String })
const StoredCompletion = Schema.Union([
  Schema.Struct({ status: Schema.Literal("admitting"), handle: CompletionHandle, text: Schema.String }),
  Schema.Struct({ status: Schema.Literal("pending"), handle: CompletionHandle }),
  Schema.Struct({ status: Schema.Literal("completed"), handle: CompletionHandle, notification: OpenCodeNotification }),
])
const StoredCompletions = Schema.Array(StoredCompletion)

export async function createCompletionStore(
  path = join(process.env["XDG_STATE_HOME"] ?? join(homedir(), ".local", "state"), "opencode", "voice-prompts.json"),
) {
  await mkdir(dirname(path), { recursive: true })
  const directory = `${path}.d`
  await mkdir(directory, { recursive: true })
  const files = (await readdir(directory)).filter((name) => name.endsWith(".json"))
  const decoded = files.length > 0
    ? await Promise.all(
        files.map(async (name) => {
          const entry = Option.getOrUndefined(
            Schema.decodeUnknownOption(StoredCompletion)(await Bun.file(join(directory, name)).json()),
          )
          if (!entry) throw new Error(`Invalid voice completion entry: ${join(directory, name)}`)
          return entry
        }),
      )
    : (await Bun.file(path).exists())
      ? Option.getOrUndefined(Schema.decodeUnknownOption(StoredCompletions)(await Bun.file(path).json()))
      : []
  if (!decoded) throw new Error(`Invalid voice completion store: ${path}`)
  const entries = new Map(decoded.map((entry) => [promptKey(entry.handle), entry]))
  let writes = Promise.resolve()

  const enqueue = (operation: () => Promise<void>) => {
    const result = writes.then(operation)
    writes = result.catch(() => {})
    return result
  }

  const save = (entry: StoredCompletion) => {
    return enqueue(async () => {
      const target = completionPath(directory, entry.handle)
      const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`
      await Bun.write(temporary, JSON.stringify(entry))
      await rename(temporary, target)
    })
  }

  if (files.length === 0 && decoded.length > 0) {
    await Promise.all(decoded.map(save))
    await rm(path, { force: true })
  }
  if (files.length > 0) {
    const existing = new Set(files)
    await Promise.all(decoded.filter((entry) => !existing.has(completionFilename(entry.handle))).map(save))
    const current = new Set(decoded.map((entry) => completionFilename(entry.handle)))
    await Promise.all(files.filter((name) => !current.has(name)).map((name) => rm(join(directory, name), { force: true })))
  }

  return {
    entries: () => [...entries.entries()].toSorted(([left], [right]) => left.localeCompare(right)).map(([, entry]) => entry),
    admitting(handle: CompletionHandle, text: string) {
      const entry = { status: "admitting", handle, text } as const
      entries.set(promptKey(handle), entry)
      return save(entry)
    },
    pending(handle: CompletionHandle) {
      const entry = { status: "pending", handle } as const
      entries.set(promptKey(handle), entry)
      return save(entry)
    },
    completed(handle: CompletionHandle, notification: OpenCodeNotification) {
      const entry = { status: "completed", handle, notification } as const
      entries.set(promptKey(handle), entry)
      return save(entry)
    },
    remove(handle: CompletionHandle) {
      if (!entries.delete(promptKey(handle))) return writes
      return enqueue(() => rm(completionPath(directory, handle), { force: true }))
    },
    close: () => writes,
  }
}

export type CompletionStore = Awaited<ReturnType<typeof createCompletionStore>>

function completionFilename(handle: CompletionHandle) {
  return `${encodeURIComponent(promptKey(handle))}.json`
}

function completionPath(directory: string, handle: CompletionHandle) {
  return join(directory, completionFilename(handle))
}
