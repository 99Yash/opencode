import { describe, expect, test } from "bun:test"
import type { BrowserPaneState } from "@opencode-ai/app/desktop"
import type { ElectronAPI } from "../api-types"
import { createDesktopBrowser } from "./browser"

const binding = {
  sessionID: "ses_desktop_browser",
  bindingID: "browser-binding",
  endpoint: { url: "http://127.0.0.1:4096" },
}
const state: BrowserPaneState = {
  url: "https://example.com",
  title: "Example",
  loading: false,
  canGoBack: false,
  canGoForward: false,
}

describe("desktop browser platform", () => {
  test("waits for registration and scopes open and state events to their session binding", async () => {
    const ready = Promise.withResolvers<void>()
    const calls: unknown[] = []
    const opened = new Set<(event: { bindingID: string }) => void>()
    const changed = new Set<(event: { bindingID: string; state: BrowserPaneState }) => void>()
    const api = {
      browserPane: {
        register: () => ready.promise,
        unregister: async (bindingID: string) => {
          calls.push({ unregister: bindingID })
        },
        setLayout: (bindingID: string, layout: unknown) => calls.push({ bindingID, layout }),
        command: async (_bindingID: string, command: unknown) => {
          calls.push({ command })
        },
        state: async () => state,
        onOpen: (callback: (event: { bindingID: string }) => void) => {
          opened.add(callback)
          return () => opened.delete(callback)
        },
        onState: (callback: (event: { bindingID: string; state: BrowserPaneState }) => void) => {
          changed.add(callback)
          return () => changed.delete(callback)
        },
      },
    } as ElectronAPI
    let openCount = 0
    const browser = createDesktopBrowser(api).register(binding, () => openCount++)
    browser.setLayout({ visible: true, bounds: { x: 0, y: 0, width: 800, height: 600 } })
    expect(calls).toEqual([])

    opened.forEach((callback) => callback({ bindingID: "another-binding" }))
    opened.forEach((callback) => callback({ bindingID: binding.bindingID }))
    expect(openCount).toBe(1)

    ready.resolve()
    await ready.promise
    expect(calls).toEqual([
      { bindingID: binding.bindingID, layout: { visible: true, bounds: { x: 0, y: 0, width: 800, height: 600 } } },
    ])

    const states: BrowserPaneState[] = []
    const unsubscribe = await browser.subscribe((value) => states.push(value))
    changed.forEach((callback) => callback({ bindingID: "another-binding", state }))
    changed.forEach((callback) => callback({ bindingID: binding.bindingID, state: { ...state, loading: true } }))
    expect(states).toEqual([state, { ...state, loading: true }])
    unsubscribe()
    expect(changed.size).toBe(0)

    await browser.command({ type: "reload" })
    expect(calls).toContainEqual({ command: { type: "reload" } })
    browser.close()
    await Promise.resolve()
    expect(calls).toContainEqual({ unregister: binding.bindingID })
    expect(opened.size).toBe(0)
  })

  test("closes a registration that finishes after its platform handle was disposed", async () => {
    const ready = Promise.withResolvers<void>()
    const calls: string[] = []
    const api = {
      browserPane: {
        register: () => ready.promise,
        unregister: async (bindingID: string) => {
          calls.push(bindingID)
        },
        onOpen: () => () => undefined,
      },
    } as ElectronAPI
    const browser = createDesktopBrowser(api).register(binding, () => undefined)
    browser.close()
    expect(calls).toEqual([])
    ready.resolve()
    await ready.promise
    expect(calls).toEqual([binding.bindingID])
  })
})
