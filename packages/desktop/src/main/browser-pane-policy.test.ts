import { describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { allowedDestination, configureBrowserPage, destinationOrigin, normalizeBounds } from "./browser-pane-policy"

describe("browser navigation policy", () => {
  test("denies permissions, device access, screen capture, downloads, popups, and foreign navigation", () => {
    const handlers: {
      request?: (_contents: unknown, _permission: unknown, callback: (allowed: boolean) => void) => void
      check?: () => boolean
      device?: () => boolean
      display?: (_request: unknown, callback: (streams: object) => void) => void
      popup?: () => { action: string }
    } = {}
    const session = new EventEmitter()
    Object.assign(session, {
      setPermissionRequestHandler: (handler: typeof handlers.request) => (handlers.request = handler),
      setPermissionCheckHandler: (handler: typeof handlers.check) => (handlers.check = handler),
      setDevicePermissionHandler: (handler: typeof handlers.device) => (handlers.device = handler),
      setDisplayMediaRequestHandler: (handler: typeof handlers.display) => (handlers.display = handler),
    })
    const contents = new EventEmitter()
    Object.assign(contents, {
      session,
      setWindowOpenHandler: (handler: typeof handlers.popup) => (handlers.popup = handler),
    })

    const blocked: string[] = []
    configureBrowserPage(
      contents as Electron.WebContents,
      () => "https://example.com",
      (url) => blocked.push(url),
    )

    let permission = true
    handlers.request?.({}, "media", (allowed) => (permission = allowed))
    expect(permission).toBe(false)
    expect(handlers.check?.()).toBe(false)
    expect(handlers.device?.()).toBe(false)
    let streams: object | undefined
    handlers.display?.({}, (value) => (streams = value))
    expect(streams).toEqual({})
    expect(handlers.popup?.()).toEqual({ action: "deny" })

    const prevented: string[] = []
    session.emit("will-download", { preventDefault: () => prevented.push("download") })
    contents.emit("content-bounds-updated", { preventDefault: () => prevented.push("bounds") })
    contents.emit("will-navigate", {
      url: "https://other.example",
      isMainFrame: true,
      preventDefault: () => prevented.push("navigation"),
    })
    contents.emit("will-redirect", {
      url: "https://other.example",
      isMainFrame: true,
      preventDefault: () => prevented.push("redirect"),
    })
    contents.emit("will-redirect", {
      url: "https://other.example",
      isMainFrame: false,
      preventDefault: () => prevented.push("subframe"),
    })
    expect(prevented).toEqual(["download", "bounds", "navigation", "redirect"])
    expect(blocked).toEqual(["https://other.example", "https://other.example"])
  })

  test("accepts only credential-free HTTP and HTTPS destinations", () => {
    expect(destinationOrigin("https://example.com/path?q=1")).toBe("https://example.com")
    expect(destinationOrigin("http://127.0.0.1:4096")).toBe("http://127.0.0.1:4096")

    for (const value of [
      "about:blank",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "data:text/html,test",
      "https://user:password@example.com",
      "not a URL",
    ]) {
      expect(destinationOrigin(value)).toBeUndefined()
    }
  })

  test("allows only the approved origin and the isolated initial blank document", () => {
    expect(allowedDestination("https://example.com/other", "https://example.com")).toBe(true)
    expect(allowedDestination("about:blank", "https://example.com")).toBe(true)
    expect(allowedDestination("https://example.com:8443", "https://example.com")).toBe(false)
    expect(allowedDestination("https://other.example", "https://example.com")).toBe(false)
    expect(allowedDestination("file:///etc/passwd", "https://example.com")).toBe(false)
  })
})

describe("browser pane bounds", () => {
  test("rounds and clips the view to its owning window", () => {
    expect(normalizeBounds({ x: -4.6, y: 20.4, width: 104.9, height: 100 }, { width: 80, height: 90 })).toEqual({
      x: 0,
      y: 20,
      width: 80,
      height: 70,
    })
  })

  test("rejects invisible, invalid, and completely clipped surfaces", () => {
    const parent = { width: 800, height: 600 }
    for (const bounds of [
      { x: 0, y: 0, width: 0, height: 1 },
      { x: 0, y: 0, width: 1, height: -1 },
      { x: 800, y: 0, width: 10, height: 10 },
      { x: 0, y: 600, width: 10, height: 10 },
      { x: Number.NaN, y: 0, width: 1, height: 1 },
      { x: 0, y: 0, width: Number.POSITIVE_INFINITY, height: 1 },
    ]) {
      expect(normalizeBounds(bounds, parent)).toBeUndefined()
    }
    expect(normalizeBounds({ x: 0, y: 0, width: 1, height: 1 }, { width: 0, height: 10 })).toBeUndefined()
  })
})
