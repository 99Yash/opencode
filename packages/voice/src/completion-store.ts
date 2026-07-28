import { mkdir, rename } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { Option, Schema } from "effect"
import { OpenCodeNotification } from "./opencode-notification"

export type CompletionHandle = { readonly sessionID: string; readonly promptID: string }
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
  const decoded = (await Bun.file(path).exists())
    ? Option.getOrUndefined(Schema.decodeUnknownOption(StoredCompletions)(await Bun.file(path).json()))
    : []
  if (!decoded) throw new Error(`Invalid voice completion store: ${path}`)
  const entries = new Map(decoded.map((entry) => [entry.handle.promptID, entry]))
  let writes = Promise.resolve()

  const save = () => {
    const json = JSON.stringify([...entries.values()])
    writes = writes.then(async () => {
      const temporary = `${path}.${process.pid}.tmp`
      await Bun.write(temporary, json)
      await rename(temporary, path)
    })
    return writes
  }

  return {
    entries: () => [...entries.values()],
    admitting(handle: CompletionHandle, text: string) {
      entries.set(handle.promptID, { status: "admitting", handle, text })
      return save()
    },
    pending(handle: CompletionHandle) {
      entries.set(handle.promptID, { status: "pending", handle })
      return save()
    },
    completed(handle: CompletionHandle, notification: OpenCodeNotification) {
      entries.set(handle.promptID, { status: "completed", handle, notification })
      return save()
    },
    delivered(promptID: string) {
      if (!entries.delete(promptID)) return writes
      return save()
    },
    close: () => writes,
  }
}

export type CompletionStore = Awaited<ReturnType<typeof createCompletionStore>>
