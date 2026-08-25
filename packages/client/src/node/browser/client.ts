import { BrowserControlProtocol } from "@opencode-ai/protocol/browser-control"
import { Browser } from "@opencode-ai/schema/browser"
import type { BrowserControl } from "@opencode-ai/schema/browser-control"
import { Session } from "@opencode-ai/schema/session"
import { Effect, Schema } from "effect"
import WebSocket from "ws"
import type { ClientOptions } from "../../promise/generated/client.js"
import type { BrowserDriver, BrowserDriverInstance } from "./driver.js"
import { createBrowserProxy } from "./proxy.js"
import { openBrowserTunnel, type BrowserTunnelEndpoint } from "./tunnel.js"

export interface BrowserRegisterOptions {
  readonly sessionID: string
  readonly open: () => Promise<void> | void
}

export interface BrowserAttachOptions<Resource> {
  readonly driver: BrowserDriver<Resource>
  readonly signal?: AbortSignal
}

export interface BrowserAttachment<Resource> extends AsyncDisposable {
  readonly resource: Resource
  readonly close: () => Promise<void>
}

export interface BrowserRegistration extends AsyncDisposable {
  readonly attach: <Resource>(options: BrowserAttachOptions<Resource>) => Promise<BrowserAttachment<Resource>>
  readonly close: () => Promise<void>
}

export interface BrowserClient {
  readonly register: (options: BrowserRegisterOptions) => Promise<BrowserRegistration>
}

type Attachment = {
  readonly leaseID: Browser.LeaseID
  readonly abort: AbortController
  readonly attached: PromiseWithResolvers<void>
  readonly externalSignal?: AbortSignal
  readonly externalAbort: () => void
  state?: Browser.State
  execute?: BrowserDriverInstance<unknown>["execute"]
  unsubscribe?: () => void
  dispose?: () => Promise<void> | void
  proxy?: Awaited<ReturnType<typeof createBrowserProxy>>
  sent: boolean
  acknowledged: boolean
  closed: boolean
  closing?: Promise<void>
}

export function createBrowserClient(options: ClientOptions): BrowserClient {
  const url = new URL(options.baseUrl)
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    throw new TypeError("Browser server endpoint must be an HTTP URL without embedded credentials")
  }
  const authorization = new Headers(options.headers).get("authorization") ?? undefined
  const endpoint: BrowserTunnelEndpoint = { url: url.href, ...(authorization ? { authorization } : {}) }
  return {
    register: async (input) => {
      if (!Schema.is(Session.ID)(input.sessionID))
        throw new TypeError("Browser registration requires a valid Session ID")
      if (typeof input.open !== "function") throw new TypeError("Browser registration requires an open callback")
      const registration = new BrowserRegistrationControl(endpoint, Session.ID.make(input.sessionID), input.open)
      await abortable(registration.registered.promise, AbortSignal.timeout(10_000)).catch(async (error: unknown) => {
        await registration.close().catch(() => undefined)
        throw error
      })
      return registration
    },
  }
}

class BrowserRegistrationControl implements BrowserRegistration {
  readonly registered = Promise.withResolvers<void>()
  private readonly requests = new Map<BrowserControl.RequestID, AbortController>()
  private readonly cancelled = new Set<Browser.LeaseID>()
  private readonly socket: WebSocket
  private attachment?: Attachment
  private closed = false
  private closing?: Promise<void>

  constructor(
    private readonly endpoint: BrowserTunnelEndpoint,
    private readonly sessionID: Session.ID,
    private readonly open: BrowserRegisterOptions["open"],
  ) {
    const url = new URL(endpoint.url)
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
    url.pathname = BrowserControlProtocol.Path
    url.search = ""
    url.hash = ""
    this.socket = new WebSocket(url, BrowserControlProtocol.Subprotocol, {
      ...(endpoint.authorization ? { headers: { Authorization: endpoint.authorization } } : {}),
      handshakeTimeout: 10_000,
      maxPayload: BrowserControlProtocol.MaxMessageBytes,
      perMessageDeflate: false,
      followRedirects: false,
    })
    this.socket.once("open", () => this.send({ type: "browser.control.register", sessionID }))
    this.socket.on("message", (data, binary) => void this.receive(data, binary))
    this.socket.on("error", (error) => {
      const status = /^Unexpected server response: (\d+)$/.exec(error.message)?.[1]
      this.fail(new Error(status ? `Browser control connection was rejected with HTTP ${status}` : error.message))
    })
    if (!process.versions.bun) {
      this.socket.on("unexpected-response", (_request, response) => {
        response.resume()
        this.fail(new Error(`Browser control connection was rejected with HTTP ${response.statusCode}`))
      })
    }
    this.socket.on("close", () => this.fail(new Error("Browser control connection closed.")))
  }

  async attach<Resource>(input: BrowserAttachOptions<Resource>): Promise<BrowserAttachment<Resource>> {
    if (this.closed) throw new Error("Browser registration is closed")
    if (this.attachment) throw new Error("A browser is already attached to this registration")
    if (input.signal?.aborted) throw abortError(input.signal, "Browser attachment was aborted")
    const record: Attachment = {
      leaseID: Browser.LeaseID.create(),
      abort: new AbortController(),
      attached: Promise.withResolvers<void>(),
      externalSignal: input.signal,
      externalAbort: () =>
        void this.closeAttachment(record, abortError(input.signal, "Browser attachment was aborted")),
      sent: false,
      acknowledged: false,
      closed: false,
    }
    this.attachment = record
    void record.attached.promise.catch(() => undefined)
    input.signal?.addEventListener("abort", record.externalAbort, { once: true })

    return Promise.resolve()
      .then(async () => {
        const proxy = await this.openProxy(record)
        record.proxy = proxy
        const instance = await input.driver({
          proxy: Object.freeze({
            url: proxy.url,
            host: proxy.host,
            port: proxy.port,
            credentials: Object.freeze({ ...proxy.credentials }),
          }),
          signal: record.abort.signal,
        })
        if (record.closed) {
          await instance.dispose()
          throw abortError(record.abort.signal, "Browser attachment was closed")
        }
        record.dispose = () => instance.dispose()
        record.execute = (command, options) => instance.execute(command, options)
        record.state = instance.state()
        if (!Schema.is(Browser.State)(record.state)) throw new TypeError("Browser driver returned an invalid state")
        record.unsubscribe = instance.subscribe((state) => {
          if (record.closed) return
          if (!Schema.is(Browser.State)(state)) {
            this.fail(new TypeError("Browser driver returned an invalid state"))
            return
          }
          record.state = state
          if (record.acknowledged) this.send({ type: "browser.control.state", leaseID: record.leaseID, state })
        })
        this.send({ type: "browser.control.attach", leaseID: record.leaseID, state: record.state })
        record.sent = true
        await abortable(record.attached.promise, AbortSignal.any([record.abort.signal, AbortSignal.timeout(10_000)]))
        record.acknowledged = true
        this.send({ type: "browser.control.state", leaseID: record.leaseID, state: record.state })
        const close = () => this.closeAttachment(record)
        return Object.freeze({ resource: instance.resource, close, [Symbol.asyncDispose]: close })
      })
      .catch(async (error: unknown) => {
        await this.closeAttachment(record).catch(() => undefined)
        throw error
      })
  }

  close() {
    if (this.closing) return this.closing
    this.closed = true
    this.closing = (this.attachment ? this.closeAttachment(this.attachment) : Promise.resolve()).finally(() => {
      this.requests.forEach((request) => request.abort())
      this.requests.clear()
      if (this.socket.readyState === WebSocket.OPEN) this.socket.close(1000)
      if (this.socket.readyState === WebSocket.CONNECTING) this.socket.terminate()
    })
    return this.closing
  }

  [Symbol.asyncDispose]() {
    return this.close()
  }

  private async openProxy(record: Attachment) {
    const proxy = await createBrowserProxy({
      connect: async (target, signal) => {
        await abortable(record.attached.promise, signal)
        return openBrowserTunnel({
          endpoint: this.endpoint,
          sessionID: this.sessionID,
          leaseID: record.leaseID,
          target,
          signal: AbortSignal.any([signal, record.abort.signal]),
        })
      },
    })
    if (record.closed) {
      await proxy.close()
      throw abortError(record.abort.signal, "Browser attachment was closed")
    }
    return proxy
  }

  private closeAttachment(record: Attachment, reason = new Error("Browser attachment was closed")) {
    if (record.closing) return record.closing
    record.closed = true
    record.externalSignal?.removeEventListener("abort", record.externalAbort)
    record.abort.abort(reason)
    record.attached.reject(reason)
    this.requests.forEach((request) => request.abort(reason))
    this.requests.clear()
    if (this.attachment === record) this.attachment = undefined
    if (record.sent) {
      if (!record.acknowledged) this.cancelled.add(record.leaseID)
      this.send({ type: "browser.control.detach", leaseID: record.leaseID })
    }
    record.closing = Promise.resolve()
      .then(() => record.unsubscribe?.())
      .finally(() => record.dispose?.())
      .finally(() => record.proxy?.close())
    return record.closing
  }

  private async receive(data: WebSocket.RawData, binary: boolean) {
    if (binary) return this.fail(new Error("Invalid browser control message."))
    const payload =
      data instanceof ArrayBuffer ? new Uint8Array(data) : Array.isArray(data) ? Buffer.concat(data) : data
    const message = await Effect.runPromise(BrowserControlProtocol.decodeFromServer(payload)).catch(() => undefined)
    if (!message) return this.fail(new Error("Invalid browser control message."))
    if (message.type === "browser.control.registered") return this.registered.resolve()
    if (message.type === "browser.control.open") {
      queueMicrotask(
        () =>
          void Promise.resolve()
            .then(this.open)
            .catch((error: unknown) => this.fail(error instanceof Error ? error : new Error(String(error)))),
      )
      return
    }
    if (message.type === "browser.control.attached") {
      if (this.cancelled.delete(message.leaseID)) return
      if (this.attachment?.leaseID !== message.leaseID) return this.fail(new Error("Invalid browser control message."))
      this.attachment.attached.resolve()
      return
    }
    if (message.type === "browser.control.cancel") {
      if (this.attachment?.leaseID !== message.leaseID) return
      this.requests.get(message.requestID)?.abort(new Error("Browser command was cancelled"))
      this.requests.delete(message.requestID)
      return
    }
    void this.request(message)
  }

  private async request(message: Extract<BrowserControl.FromServer, { readonly type: "browser.control.request" }>) {
    const record = this.attachment
    if (!record?.acknowledged || record.leaseID !== message.leaseID || !record.execute) {
      this.send({
        type: "browser.control.response",
        requestID: message.requestID,
        leaseID: message.leaseID,
        outcome: { type: "failure", code: "not_attached", message: "Browser is not attached." },
      })
      return
    }
    const abort = new AbortController()
    this.requests.set(message.requestID, abort)
    const outcome = await record
      .execute(message.command, { signal: AbortSignal.any([abort.signal, record.abort.signal]) })
      .then(
        (result): Browser.Outcome =>
          Schema.is(Browser.Result)(result) && result.type === message.command.type
            ? { type: "success", result }
            : { type: "failure", code: "protocol", message: "Browser driver returned an invalid result." },
        (error): Browser.Outcome => ({
          type: "failure",
          code:
            error !== null && typeof error === "object" && "code" in error && Schema.is(Browser.ErrorCode)(error.code)
              ? error.code
              : "internal",
          message: (error instanceof Error ? error.message : String(error)).slice(0, 1_024),
        }),
      )
    if (this.requests.get(message.requestID) !== abort) return
    this.requests.delete(message.requestID)
    this.send({ type: "browser.control.response", requestID: message.requestID, leaseID: message.leaseID, outcome })
  }

  private send(message: BrowserControl.FromClient) {
    if (this.socket.readyState !== WebSocket.OPEN) return
    this.socket.send(BrowserControlProtocol.encodeFromClient(message), (error) => {
      if (error) this.fail(error)
    })
  }

  private fail(error: Error) {
    if (this.closed) return
    this.registered.reject(error)
    this.attachment?.attached.reject(error)
    void this.close()
  }
}

function abortable<Result>(promise: Promise<Result>, signal: AbortSignal) {
  if (signal.aborted) return Promise.reject(abortError(signal, "Browser operation was aborted"))
  return new Promise<Result>((resolve, reject) => {
    const abort = () => reject(abortError(signal, "Browser operation was aborted"))
    signal.addEventListener("abort", abort, { once: true })
    void promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort))
  })
}

function abortError(signal: AbortSignal | undefined, message: string) {
  return signal?.reason instanceof Error ? signal.reason : new Error(message)
}
