/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { TuiPathsProvider } from "../../src/context/runtime"
import { PromptHistoryProvider, usePromptHistory } from "../../src/prompt/history"
import { tmpdir } from "../fixture/fixture"

test("down rejects at the newest history item with an empty prompt", async () => {
  await using tmp = await tmpdir()
  const state = path.join(tmp.path, "state")
  await mkdir(state, { recursive: true })
  let history: ReturnType<typeof usePromptHistory>

  function Consumer() {
    history = usePromptHistory()
    return <box />
  }

  const app = await testRender(() => (
    <TuiPathsProvider value={{ cwd: tmp.path, home: tmp.path, state, worktree: tmp.path }}>
      <PromptHistoryProvider>
        <Consumer />
      </PromptHistoryProvider>
    </TuiPathsProvider>
  ))
  try {
    await app.renderOnce()
    history!.append("session-a", { text: "previous", files: [], agents: [], pasted: [] })

    expect(history!.move("session-a", 1, "")).toBeUndefined()
    expect(history!.move("session-a", -1, "")?.text).toBe("previous")
    expect(history!.move("session-a", 1, "previous")?.text).toBe("")
  } finally {
    app.renderer.destroy()
  }
})

test("scopes prompt history to the current session", async () => {
  await using tmp = await tmpdir()
  const state = path.join(tmp.path, "state")
  await mkdir(state, { recursive: true })
  let history: ReturnType<typeof usePromptHistory>

  function Consumer() {
    history = usePromptHistory()
    return <box />
  }

  const app = await testRender(() => (
    <TuiPathsProvider value={{ cwd: tmp.path, home: tmp.path, state, worktree: tmp.path }}>
      <PromptHistoryProvider>
        <Consumer />
      </PromptHistoryProvider>
    </TuiPathsProvider>
  ))
  try {
    await app.renderOnce()
    history!.append("session-a", { text: "from a", files: [], agents: [], pasted: [] })
    history!.append("session-b", { text: "from b", files: [], agents: [], pasted: [] })

    expect(history!.move("session-a", -1, "")?.text).toBe("from a")
    expect(history!.move("session-b", -1, "")?.text).toBe("from b")
  } finally {
    app.renderer.destroy()
  }
})
