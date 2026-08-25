import { describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import type { BrowserPaneState } from "@opencode-ai/app/desktop"
import type { WebContentsView } from "electron"
import { observeBrowserPage, type BrowserPage } from "./browser-chromium"

describe("browser page state", () => {
  test("publishes loading and native errors without reporting intentionally aborted or subframe loads", () => {
    const contents = new EventEmitter()
    const debuggerEvents = new EventEmitter()
    Object.assign(contents, {
      debugger: debuggerEvents,
      isDestroyed: () => false,
      getURL: () => "https://example.com",
      getTitle: () => "Example",
      isLoading: () => false,
      navigationHistory: { canGoBack: () => false, canGoForward: () => false },
    })
    const page: BrowserPage = {
      view: { webContents: contents } as WebContentsView,
      abort: new AbortController(),
      listeners: new Set(),
      approvedOrigin: "https://example.com",
      state: { url: "", title: "", loading: false, canGoBack: false, canGoForward: false, ready: true },
      closed: false,
    }
    const states: Array<{ state: BrowserPaneState; changed?: boolean }> = []
    const failures: string[] = []
    observeBrowserPage(
      page,
      (state, changed) => {
        page.state = state
        states.push({ state, changed })
      },
      (reason) => failures.push(reason),
    )

    contents.emit("did-start-navigation", {
      isMainFrame: true,
      isSameDocument: false,
      url: "https://example.com/page",
    })
    expect(states.at(-1)).toEqual({
      state: {
        url: "https://example.com/page",
        title: "Example",
        loading: true,
        canGoBack: false,
        canGoForward: false,
        ready: true,
      },
      changed: true,
    })

    contents.emit("did-fail-load", {}, -3, "ERR_ABORTED", "https://example.com/page", true)
    contents.emit("did-fail-load", {}, -105, "ERR_NAME_NOT_RESOLVED", "https://iframe.example", false)
    expect(states).toHaveLength(1)

    contents.emit("did-fail-load", {}, -105, "ERR_NAME_NOT_RESOLVED", "https://example.com/page", true)
    expect(states.at(-1)?.state).toMatchObject({
      url: "https://example.com/page",
      loading: false,
      ready: true,
      error: "ERR_NAME_NOT_RESOLVED",
    })
    contents.emit("did-stop-loading")
    expect(states.at(-1)?.state.error).toBe("ERR_NAME_NOT_RESOLVED")

    contents.emit("did-start-navigation", {
      isMainFrame: true,
      isSameDocument: false,
      url: "https://example.com/retry",
    })
    expect(states.at(-1)?.state.error).toBeUndefined()

    contents.emit("render-process-gone", {}, { reason: "crashed" })
    debuggerEvents.emit("detach", {}, "target closed")
    expect(failures).toEqual(["crashed", "target closed"])
  })
})
