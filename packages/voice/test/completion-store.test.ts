import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createCompletionStore } from "../src/completion-store"

test("completion store restores pending and completed notifications until delivery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "voice-completions-"))
  const path = join(directory, "prompts.json")
  const first = await createCompletionStore(path)
  const pending = { sessionID: "session-1", promptID: "prompt-1" }
  const completed = { sessionID: "session-2", promptID: "prompt-2" }

  try {
    await first.admitting(pending, "Please continue")
    expect(first.entries()).toEqual([{ status: "admitting", handle: pending, text: "Please continue" }])
    await first.pending(pending)
    await first.pending(completed)
    await first.completed(completed, {
      type: "opencode.prompt.completed",
      session_id: "session-2",
      prompt_id: "prompt-2",
      status: "completed",
      text: "done",
    })
    await first.close()

    const restored = await createCompletionStore(path)
    expect(restored.entries()).toEqual([
      { status: "pending", handle: pending },
      {
        status: "completed",
        handle: completed,
        notification: {
          type: "opencode.prompt.completed",
          session_id: "session-2",
          prompt_id: "prompt-2",
          status: "completed",
          text: "done",
        },
      },
    ])

    await restored.delivered("prompt-2")
    await restored.close()
    expect((await createCompletionStore(path)).entries()).toEqual([{ status: "pending", handle: pending }])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
