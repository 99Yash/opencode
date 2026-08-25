import { describe, expect, test } from "bun:test"
import { browserPaneAvailable, createBrowserPaneBinding } from "./browser-pane"

describe("browser pane availability", () => {
  const available = {
    platform: true,
    enabled: true,
    ready: true,
    renderable: true,
    sessionID: "session-a",
    supported: true,
  }

  test("requires a supported platform, hydrated preference, renderable viewport, and session", () => {
    expect(browserPaneAvailable(available)).toBe(true)
    expect(browserPaneAvailable({ ...available, platform: false })).toBe(false)
    expect(browserPaneAvailable({ ...available, enabled: false })).toBe(false)
    expect(browserPaneAvailable({ ...available, ready: false })).toBe(false)
    expect(browserPaneAvailable({ ...available, renderable: false })).toBe(false)
    expect(browserPaneAvailable({ ...available, sessionID: undefined })).toBe(false)
    expect(browserPaneAvailable({ ...available, supported: false })).toBe(false)
  })

  test("gives each registration its own binding while preserving server credentials", () => {
    const endpoint = { url: "http://localhost:4096", username: "user", password: "secret" }
    const first = createBrowserPaneBinding({ sessionID: "session-a", endpoint })
    const second = createBrowserPaneBinding({ sessionID: "session-a", endpoint })

    expect(first.sessionID).toBe("session-a")
    expect(first.endpoint).toBe(endpoint)
    expect(first.bindingID).not.toBe(second.bindingID)
  })
})
