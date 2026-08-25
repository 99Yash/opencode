import { BrowserTunnelProtocol } from "@opencode-ai/protocol/browser-tunnel"
import type { Browser } from "@opencode-ai/schema/browser"
import type { BrowserTunnel } from "@opencode-ai/schema/browser-tunnel"
import type { Session } from "@opencode-ai/schema/session"
import { Effect } from "effect"
import { Duplex } from "node:stream"
import WebSocket from "ws"

export interface BrowserTunnelEndpoint {
  readonly url: string
  readonly authorization?: string
}

interface BrowserTunnelOpen {
  readonly endpoint: BrowserTunnelEndpoint
  readonly sessionID: Session.ID
  readonly leaseID: Browser.LeaseID
  readonly target: BrowserTunnel.Target
  readonly signal?: AbortSignal
}

export class BrowserTunnelError extends Error {
  override readonly name = "BrowserTunnelError"

  constructor(
    readonly code: BrowserTunnel.OpenErrorCode | "transport",
    message: string,
  ) {
    super(message)
  }
}

export async function openBrowserTunnel(input: BrowserTunnelOpen): Promise<Duplex> {
  const stream = new BrowserTunnelStream(input)
  const timeout = AbortSignal.timeout(15_000)
  const cancel = () => stream.destroy(new BrowserTunnelError("transport", "Browser tunnel handshake timed out."))
  timeout.addEventListener("abort", cancel, { once: true })
  await stream.opened.promise.finally(() => timeout.removeEventListener("abort", cancel))
  return stream
}

class BrowserTunnelStream extends Duplex {
  readonly connecting = false
  readonly opened = Promise.withResolvers<void>()
  private readonly socket: WebSocket
  private readonly signal?: AbortSignal
  private state: "opening" | "open" | "closed" = "opening"
  private paused = false

  constructor(input: BrowserTunnelOpen) {
    super()
    this.on("error", () => undefined)
    this.signal = input.signal
    const url = new URL(input.endpoint.url)
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
    url.pathname = BrowserTunnelProtocol.Path
    url.search = ""
    url.hash = ""
    this.socket = new WebSocket(url, BrowserTunnelProtocol.Subprotocol, {
      ...(input.endpoint.authorization ? { headers: { Authorization: input.endpoint.authorization } } : {}),
      handshakeTimeout: 10_000,
      maxPayload: BrowserTunnelProtocol.MaxFrameBytes,
      perMessageDeflate: false,
      followRedirects: false,
    })
    this.socket.once("open", () =>
      this.socket.send(
        BrowserTunnelProtocol.encodeFromClient({
          type: "browser.tunnel.open",
          sessionID: input.sessionID,
          leaseID: input.leaseID,
          target: input.target,
        }),
      ),
    )
    this.socket.on("message", (data, binary) => void this.receive(data, binary))
    this.socket.on("error", (error) => this.fail(new BrowserTunnelError("transport", error.message)))
    this.socket.on("close", () => {
      if (this.state === "opening") {
        this.fail(new BrowserTunnelError("transport", "Browser tunnel closed while opening."))
        return
      }
      if (this.state !== "open") return
      this.state = "closed"
      this.push(null)
      this.destroy()
    })
    this.signal?.addEventListener("abort", this.onAbort, { once: true })
    if (this.signal?.aborted) this.onAbort()
  }

  override _read() {
    if (!this.paused) return
    this.paused = false
    this.socket.resume()
  }

  override _write(chunk: Buffer | string, encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    if (this.state !== "open") return callback(new BrowserTunnelError("transport", "Browser tunnel is not writable."))
    const data = typeof chunk === "string" ? Buffer.from(chunk, encoding) : chunk
    const send = (offset: number) => {
      if (offset >= data.byteLength) return callback()
      this.socket.send(
        data.subarray(offset, offset + BrowserTunnelProtocol.MaxFrameBytes),
        { binary: true },
        (error) => {
          if (error) return callback(error)
          send(offset + BrowserTunnelProtocol.MaxFrameBytes)
        },
      )
    }
    send(0)
  }

  override _final(callback: (error?: Error | null) => void) {
    if (this.socket.readyState === WebSocket.OPEN) this.socket.close(1000)
    callback()
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void) {
    this.signal?.removeEventListener("abort", this.onAbort)
    if (this.state === "opening" && error) this.opened.reject(error)
    this.state = "closed"
    if (this.socket.readyState === WebSocket.OPEN) this.socket.close(1000)
    if (this.socket.readyState === WebSocket.CONNECTING) this.socket.terminate()
    callback(error)
  }

  setKeepAlive() {
    return this
  }

  setNoDelay() {
    return this
  }

  setTimeout(_timeout: number, callback?: () => void) {
    if (callback) this.once("timeout", callback)
    return this
  }

  ref() {
    return this
  }

  unref() {
    return this
  }

  private async receive(data: WebSocket.RawData, binary: boolean) {
    if (this.state === "opening") {
      if (binary) return this.fail(new BrowserTunnelError("transport", "Browser tunnel handshake must be text."))
      const payload =
        data instanceof ArrayBuffer ? new Uint8Array(data) : Array.isArray(data) ? Buffer.concat(data) : data
      const message = await Effect.runPromise(BrowserTunnelProtocol.decodeFromServer(payload)).catch(() => undefined)
      if (!message) return this.fail(new BrowserTunnelError("transport", "Browser tunnel handshake is invalid."))
      if (message.type === "browser.tunnel.rejected")
        return this.fail(new BrowserTunnelError(message.code, message.message))
      this.state = "open"
      this.opened.resolve()
      return
    }
    if (this.state !== "open") return
    if (!binary) return this.fail(new BrowserTunnelError("transport", "Browser tunnel payload is invalid."))
    const payload =
      data instanceof ArrayBuffer ? new Uint8Array(data) : Array.isArray(data) ? Buffer.concat(data) : data
    if (this.push(payload)) return
    this.paused = true
    this.socket.pause()
  }

  private fail(error: BrowserTunnelError) {
    if (this.state === "closed") return
    if (this.state === "opening") this.opened.reject(error)
    this.destroy(error)
  }

  private readonly onAbort = () => this.fail(new BrowserTunnelError("transport", "Browser tunnel was cancelled."))
}
