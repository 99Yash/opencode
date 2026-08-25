import { describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { installBrowserNetwork } from "./browser-network"

const proxy = {
  url: "http://127.0.0.1:4080",
  host: "127.0.0.1",
  port: 4080,
  credentials: { username: "browser", password: "secret" },
}

describe("browser proxy isolation", () => {
  test("forces loopback through the authenticated proxy and cleans up exactly once", async () => {
    const contents = new EventEmitter()
    const calls: unknown[] = []
    Object.assign(contents, {
      isDestroyed: () => false,
      setWebRTCIPHandlingPolicy: (policy: string) => calls.push({ policy }),
    })
    const session = {
      setProxy: async (config: unknown) => {
        calls.push(config)
      },
      closeAllConnections: async () => {
        calls.push("close")
      },
    }
    const dispose = await installBrowserNetwork({
      proxy,
      session: session as Electron.Session,
      webContents: contents as Electron.WebContents,
    })

    expect(calls).toEqual([
      { policy: "disable_non_proxied_udp" },
      { mode: "fixed_servers", proxyRules: proxy.url, proxyBypassRules: "<-loopback>" },
      "close",
    ])

    const credentials: Array<[string | undefined, string | undefined]> = []
    const event = { preventDefault: () => calls.push("prevent") }
    contents.emit(
      "login",
      event,
      {},
      { isProxy: true, scheme: "basic", host: proxy.host, port: proxy.port, realm: "OpenCode Browser Proxy" },
      (username?: string, password?: string) => credentials.push([username, password]),
    )
    contents.emit(
      "login",
      event,
      {},
      { isProxy: true, scheme: "basic", host: "other.example", port: proxy.port, realm: "OpenCode Browser Proxy" },
      (username?: string, password?: string) => credentials.push([username, password]),
    )
    expect(credentials).toEqual([["browser", "secret"]])

    dispose()
    dispose()
    expect(contents.listenerCount("login")).toBe(0)
    expect(calls.filter((call) => call === "close")).toHaveLength(2)
  })

  test("removes proxy credentials and closes connections when proxy setup fails", async () => {
    const contents = new EventEmitter()
    let closed = 0
    Object.assign(contents, {
      isDestroyed: () => false,
      setWebRTCIPHandlingPolicy: () => undefined,
    })
    const session = {
      setProxy: async () => {
        throw new Error("proxy setup failed")
      },
      closeAllConnections: async () => {
        closed++
      },
    }

    await expect(
      installBrowserNetwork({
        proxy,
        session: session as Electron.Session,
        webContents: contents as Electron.WebContents,
      }),
    ).rejects.toThrow("proxy setup failed")
    expect(contents.listenerCount("login")).toBe(0)
    expect(closed).toBe(1)
  })
})
