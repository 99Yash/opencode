import { Browser, BrowserDriver, type BrowserDriverContext, type ChromiumPort } from "@opencode-ai/client/node"
import { describe, expect, test } from "bun:test"

type Port = ChromiumPort<{ readonly name: string }>
type Command = Parameters<Port["send"]>[0]
type Listener = Parameters<Port["subscribe"]>[0]

const context = {
  proxy: { url: "http://127.0.0.1:1", host: "127.0.0.1", port: 1, credentials: { username: "u", password: "p" } },
  signal: new AbortController().signal,
} satisfies BrowserDriverContext

describe("Chromium browser driver", () => {
  test("snapshots accessibility refs and invalidates them when the document changes", async () => {
    const port = new FakePort()
    const instance = await BrowserDriver.chromium(() => port)(context)
    const execute = (command: Browser.Command) => instance.execute(command, { signal: new AbortController().signal })

    const snapshot = await execute({ type: "snapshot", generation: 0 })
    expect(snapshot).toMatchObject({
      type: "snapshot",
      content: expect.stringContaining('e1 [button] "Save" disabled=false'),
    })
    expect(port.expression).toContain("while (visited++ < 500)")
    expect(port.expression).not.toContain("textContent")
    await execute({ type: "click", ref: Browser.Ref.make("e1"), generation: 0 })
    expect(port.commands.filter((command) => command.method === "Input.dispatchMouseEvent")).toHaveLength(3)

    port.emit()
    expect(instance.resource.state().generation).toBe(1)
    expect(port.commands.some((command) => command.method === "Runtime.releaseObject")).toBe(true)
    await expect(execute({ type: "click", ref: Browser.Ref.make("e1"), generation: 1 })).rejects.toMatchObject({
      code: "stale_ref",
    })
    await instance.resource.dispose()
  })

  test.each([
    ["localhost", "http://localhost/"],
    ["localhost:5173", "http://localhost:5173/"],
    ["127.0.0.1:5173", "http://127.0.0.1:5173/"],
    ["[::1]:5173", "http://[::1]:5173/"],
    ["example.com", "https://example.com/"],
    ["example.com:5173", "https://example.com:5173/"],
    ["http://example.com:5173/path", "http://example.com:5173/path"],
    ["about:blank", "about:blank"],
  ])("normalizes %s to %s", async (input, expected) => {
    const port = new FakePort()
    const instance = await BrowserDriver.chromium(() => port)(context)
    await instance.resource.navigate(input)
    expect(port.navigations).toEqual([expected])
    await instance.dispose()
  })

  test.each(["file:///etc/passwd", "javascript:alert(1)", "data:text/plain,hello", "https://user:pass@example.com/"])(
    "rejects unsafe browser URL %s",
    async (input) => {
      const port = new FakePort()
      const instance = await BrowserDriver.chromium(() => port)(context)
      await expect(instance.resource.navigate(input)).rejects.toMatchObject({ code: "invalid_url" })
      expect(port.navigations).toEqual([])
      await instance.dispose()
    },
  )

  test("runs fill, press, scroll, screenshots, and remote navigation", async () => {
    const port = new FakePort()
    const instance = await BrowserDriver.chromium(() => port)(context)
    const execute = (command: Browser.Command) => instance.execute(command, { signal: new AbortController().signal })

    await execute({ type: "snapshot", generation: 0 })
    expect(await execute({ type: "fill", ref: Browser.Ref.make("e1"), text: "hello", generation: 0 })).toMatchObject({
      type: "fill",
    })
    expect(port.commands).toContainEqual({ method: "Input.insertText", params: { text: "hello" } })
    expect(await execute({ type: "press", key: "Enter", generation: 0 })).toMatchObject({ type: "press" })
    expect(await execute({ type: "scroll", direction: "down", pixels: 300, generation: 0 })).toMatchObject({
      type: "scroll",
    })
    expect(port.commands).toContainEqual({
      method: "Input.dispatchMouseEvent",
      params: { type: "mouseWheel", x: 400, y: 300, deltaX: 0, deltaY: 300 },
    })
    expect(await execute({ type: "screenshot", generation: 0 })).toMatchObject({
      type: "screenshot",
      mediaType: "image/png",
      data: new Uint8Array([1, 2, 3]),
      width: 800,
      height: 600,
    })
    expect(await execute({ type: "navigate", url: "localhost:5173", generation: 0 })).toMatchObject({
      type: "navigate",
    })
    expect(port.navigations).toEqual(["http://localhost:5173/"])
    await instance.dispose()
    await instance.dispose()
    expect(port.disposed).toBe(1)
  })
})

class FakePort implements Port {
  readonly resource = { name: "chromium" }
  readonly listeners = new Set<Listener>()
  readonly commands: Command[] = []
  readonly navigations: string[] = []
  current = { url: "https://example.com/", title: "Example", loading: false, canGoBack: false, canGoForward: false }
  expression = ""
  disposed = 0

  state() {
    return this.current
  }

  subscribe(listener: Listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async navigate(url: string) {
    this.navigations.push(url)
  }

  back() {}
  forward() {}
  reload() {}
  stop() {}

  send(command: Command) {
    this.commands.push(command)
    if (command.method === "Runtime.evaluate") {
      this.expression = command.params.expression
      return Promise.resolve({ result: { objectId: "snapshot" } })
    }
    if (command.method !== "Runtime.callFunctionOn") return Promise.resolve({})
    if (command.params.functionDeclaration === "function() { return this.result }") {
      return Promise.resolve({
        result: {
          value: {
            nodes: [{ token: "e1", role: "button", name: "Save", value: "", depth: 1, disabled: false }],
            nextRef: 1,
          },
        },
      })
    }
    if (command.params.functionDeclaration.includes("element.focus()"))
      return Promise.resolve({ result: { value: true } })
    return Promise.resolve({ result: { value: { x: 25, y: 40 } } })
  }

  viewport() {
    return { width: 800, height: 600 }
  }

  screenshot() {
    return Promise.resolve({ data: new Uint8Array([1, 2, 3]), width: 800, height: 600 })
  }

  dispose() {
    this.disposed++
  }

  emit() {
    this.current = { ...this.current, url: "https://next.example/" }
    this.listeners.forEach((listener) => listener({ state: this.current, mainDocumentChanged: true }))
  }
}
