import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import {
  BrowserPaneBindingSchema,
  BrowserPaneCommandSchema,
  BrowserPaneLayoutSchema,
  BrowserPaneStateSchema,
} from "./browser"

describe("browser pane RPC contracts", () => {
  test("accepts valid per-session browser registrations", () => {
    const binding = {
      sessionID: "ses_desktop_browser",
      bindingID: "browser-binding",
      endpoint: { url: "http://127.0.0.1:4096", username: "opencode", password: "secret" },
    }
    expect(Schema.decodeUnknownSync(BrowserPaneBindingSchema)(binding)).toEqual(binding)
  })

  test("rejects oversized, empty, and non-session registration fields", () => {
    const binding = {
      sessionID: "ses_desktop_browser",
      bindingID: "browser-binding",
      endpoint: { url: "http://127.0.0.1:4096" },
    }
    const decode = Schema.decodeUnknownSync(BrowserPaneBindingSchema)
    expect(() => decode({ ...binding, sessionID: "project_1" })).toThrow()
    expect(() => decode({ ...binding, bindingID: "" })).toThrow()
    expect(() => decode({ ...binding, bindingID: "x".repeat(129) })).toThrow()
    expect(() => decode({ ...binding, endpoint: { url: "" } })).toThrow()
  })

  test("preserves optional attachment readiness and native failures", () => {
    const decode = Schema.decodeUnknownSync(BrowserPaneStateSchema)
    const state = { url: "", title: "", loading: false, canGoBack: false, canGoForward: false }
    expect(decode(state)).toEqual(state)
    expect(decode({ ...state, ready: false, error: "ERR_CONNECTION_REFUSED" })).toEqual({
      ...state,
      ready: false,
      error: "ERR_CONNECTION_REFUSED",
    })
  })

  test("rejects non-finite layouts and unsupported browser commands", () => {
    const layout = Schema.decodeUnknownSync(BrowserPaneLayoutSchema)
    expect(() => layout({ visible: true, bounds: { x: 0, y: 0, width: Number.NaN, height: 1 } })).toThrow()
    expect(() => layout({ visible: "true" })).toThrow()

    const command = Schema.decodeUnknownSync(BrowserPaneCommandSchema)
    expect(command({ type: "navigate", url: "https://example.com" })).toEqual({
      type: "navigate",
      url: "https://example.com",
    })
    expect(() => command({ type: "navigate", url: "" })).toThrow()
    expect(() => command({ type: "openDevTools" })).toThrow()
  })
})
