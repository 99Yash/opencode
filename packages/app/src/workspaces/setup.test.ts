import { describe, expect, test } from "bun:test"
import { beginWorkspaceSetup, isWorkspaceSetupPending } from "./setup"

describe("workspace setup", () => {
  test("remains pending until the setup script finishes", async () => {
    const ready = Promise.withResolvers<void>()
    beginWorkspaceSetup("session-ready", ready.promise)

    expect(isWorkspaceSetupPending("session-ready")).toBe(true)
    ready.resolve()
    await ready.promise

    expect(isWorkspaceSetupPending("session-ready")).toBe(false)
  })

  test("clears pending setup when the script fails", async () => {
    const ready = Promise.withResolvers<void>()
    beginWorkspaceSetup("session-failed", ready.promise)

    ready.reject(new Error("setup failed"))
    await ready.promise.catch(() => undefined)

    expect(isWorkspaceSetupPending("session-failed")).toBe(false)
  })
})
