import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
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
    expect(restored.entries()).toEqual(expect.arrayContaining([
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
    ]))
    await restored.close()

    const stillPendingDelivery = await createCompletionStore(path)
    expect(stillPendingDelivery.entries().some((entry) => entry.status === "completed")).toBe(true)

    await stillPendingDelivery.remove(completed)
    await stillPendingDelivery.close()
    expect((await createCompletionStore(path)).entries()).toEqual([{ status: "pending", handle: pending }])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("completion stores do not overwrite prompts written by another process", async () => {
  const directory = await mkdtemp(join(tmpdir(), "voice-completions-concurrent-"))
  const path = join(directory, "prompts.json")
  const first = await createCompletionStore(path)
  const second = await createCompletionStore(path)

  try {
    await Promise.all([
      first.pending({ sessionID: "session-1", promptID: "prompt-shared" }),
      second.pending({ sessionID: "session-2", promptID: "prompt-shared" }),
    ])
    await Promise.all([first.close(), second.close()])
    expect((await createCompletionStore(path)).entries()).toEqual(
      expect.arrayContaining([
        { status: "pending", handle: { sessionID: "session-1", promptID: "prompt-shared" } },
        { status: "pending", handle: { sessionID: "session-2", promptID: "prompt-shared" } },
      ]),
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("continues serializing writes after one filesystem failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "voice-completions-recovery-"))
  const path = join(directory, "prompts.json")
  const store = await createCompletionStore(path)
  try {
    await rm(`${path}.d`, { recursive: true })
    await Bun.write(`${path}.d`, "not a directory")
    const failure = await store
      .pending({ sessionID: "session-1", promptID: "prompt-1" })
      .then(() => undefined, (error) => error)
    expect(failure).toBeDefined()
    await rm(`${path}.d`)
    await mkdir(`${path}.d`, { recursive: true })
    await store.pending({ sessionID: "session-2", promptID: "prompt-2" })
    await store.close()
    expect((await createCompletionStore(path)).entries()).toContainEqual({
      status: "pending",
      handle: { sessionID: "session-2", promptID: "prompt-2" },
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
