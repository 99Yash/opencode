export * as BrowserPane from "./browser-pane"

import { randomUUID } from "node:crypto"
import type {
  BrowserPaneBinding,
  BrowserPaneCommand,
  BrowserPaneLayout,
  BrowserPaneState,
} from "@opencode-ai/app/desktop"
import type { BrowserDriver, BrowserRegistration } from "@opencode-ai/client/node"
import { WebContentsView, type BrowserWindow } from "electron"
import { Context, Effect, Layer } from "effect"
import { BrowserPaneOpened, BrowserPaneStateChanged } from "../shared/ipc-rpc/events"
import { createChromiumPort, observeBrowserPage, readBrowserState, type BrowserPage } from "./browser-chromium"
import { configureBrowserPage, destinationOrigin, normalizeBounds } from "./browser-pane-policy"
import { emitIpcEvent } from "./ipc-events"
import { Shutdown } from "./lifecycle/shutdown"

type Entry = {
  readonly binding: BrowserPaneBinding
  readonly win: BrowserWindow
  readonly chromium: typeof BrowserDriver.chromium
  readonly onClosed: () => void
  readonly onResize: () => void
  readonly onNavigation: (event: Electron.Event<{ isMainFrame: boolean; isSameDocument: boolean }>) => void
  registration?: BrowserRegistration
  ready?: Promise<BrowserRegistration>
  page?: BrowserPage
  layout?: BrowserPaneLayout
  closed: boolean
  failure?: string
}

const initialState = { url: "", title: "", loading: false, canGoBack: false, canGoForward: false, ready: false }

export function createBrowserPane() {
  const entries = new Map<string, Entry>()
  let disposed = false

  return {
    async register(win: BrowserWindow, binding: BrowserPaneBinding) {
      if (disposed || !destinationOrigin(binding.endpoint.url)) throw new Error("browser.pane.registration.invalid")
      if (binding.endpoint.username && !binding.endpoint.password) throw new Error("browser.pane.endpoint.invalid")
      const { BrowserDriver, OpenCode } = await import("@opencode-ai/client/node")
      const previous = entries.get(binding.bindingID)
      if (previous && previous.win !== win) throw new Error("browser.pane.owner.invalid")
      if (previous) await closeEntry(previous)
      if (win.isDestroyed() || win.webContents.isDestroyed()) throw new Error("browser.pane.owner.unavailable")

      const client = OpenCode.make({
        baseUrl: new URL(binding.endpoint.url).href,
        headers: binding.endpoint.password
          ? {
              Authorization: `Basic ${Buffer.from(`${binding.endpoint.username ?? "opencode"}:${binding.endpoint.password}`).toString("base64")}`,
            }
          : undefined,
      })
      const entry: Entry = {
        binding,
        win,
        chromium: BrowserDriver.chromium,
        onClosed: () => void closeEntry(entry).catch(() => undefined),
        onResize: () => applyLayout(entry),
        onNavigation: (event) => {
          if (event.isMainFrame && !event.isSameDocument) void closeEntry(entry).catch(() => undefined)
        },
        closed: false,
      }
      entries.set(binding.bindingID, entry)
      win.once("closed", entry.onClosed)
      win.on("resize", entry.onResize)
      win.webContents.once("destroyed", entry.onClosed)
      win.webContents.on("did-start-navigation", entry.onNavigation)
      entry.ready = client.browser.register({
        sessionID: binding.sessionID,
        open: () => publish(entry, new BrowserPaneOpened({ bindingID: binding.bindingID })),
      })
      entry.registration = await entry.ready.catch(async (error: unknown) => {
        await closeEntry(entry)
        throw error
      })
      if (!entry.closed && !disposed) return
      await closeEntry(entry)
      throw new Error("browser.pane.registration.closed")
    },
    unregister: (win: BrowserWindow, bindingID: string) => closeEntry(owned(win, bindingID)),
    setLayout(win: BrowserWindow, bindingID: string, layout?: BrowserPaneLayout) {
      const entry = owned(win, bindingID)
      entry.layout = layout
      applyLayout(entry)
    },
    async command(win: BrowserWindow, bindingID: string, command: BrowserPaneCommand) {
      const entry = owned(win, bindingID)
      const page = entry.page
      if (!page?.ready) throw new Error("browser.pane.attachment.unavailable")
      const controller = (await page.ready).resource
      if (entry.page !== page || page.closed) throw new Error("browser.pane.attachment.closed")
      if (command.type === "navigate") return controller.navigate(command.url)
      if (command.type === "stop") return controller.stop()
      return controller[command.type]()
    },
    state(win: BrowserWindow, bindingID: string) {
      const entry = owned(win, bindingID)
      return entry.page?.state ?? { ...initialState, ...(entry.failure ? { error: entry.failure } : {}) }
    },
    async dispose() {
      disposed = true
      await Promise.all([...entries.values()].map(closeEntry))
    },
  }

  function owned(win: BrowserWindow, bindingID: string) {
    const entry = entries.get(bindingID)
    if (!entry || entry.closed || entry.win !== win) throw new Error("browser.pane.unavailable")
    return entry
  }

  async function closeEntry(entry: Entry) {
    if (entry.closed) return
    entry.closed = true
    if (entries.get(entry.binding.bindingID) === entry) entries.delete(entry.binding.bindingID)
    disposePage(entry)
    if (!entry.win.isDestroyed()) {
      entry.win.off("closed", entry.onClosed)
      entry.win.off("resize", entry.onResize)
      if (!entry.win.webContents.isDestroyed()) {
        entry.win.webContents.off("destroyed", entry.onClosed)
        entry.win.webContents.off("did-start-navigation", entry.onNavigation)
      }
    }
    await entry.ready?.then(
      (registration) => registration.close(),
      () => undefined,
    )
  }

  function applyLayout(entry: Entry) {
    if (!entry.layout) {
      entry.failure = undefined
      return disposePage(entry)
    }
    const bounds =
      entry.layout.visible && entry.layout.bounds && !entry.win.isDestroyed()
        ? normalizeBounds(entry.layout.bounds, entry.win.contentView.getBounds())
        : undefined
    if (!bounds) return entry.page?.view.setVisible(false)
    if (!entry.page && !entry.failure) createPage(entry)
    if (!entry.page || entry.page.closed) return
    entry.page.view.setBounds(bounds)
    entry.page.view.setVisible(true)
  }

  function createPage(entry: Entry) {
    const registration = entry.registration
    if (!registration) return
    const view = new WebContentsView({
      webPreferences: {
        partition: `opencode-browser-${randomUUID()}`,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        webviewTag: false,
        devTools: false,
        disableDialogs: true,
      },
    })
    const page: BrowserPage = {
      view,
      abort: new AbortController(),
      listeners: new Set(),
      approvedOrigin: "about:blank",
      state: { ...initialState },
      closed: false,
    }
    entry.page = page
    view.setVisible(false)
    view.setBorderRadius(8)
    configureBrowserPage(
      view.webContents,
      () => page.approvedOrigin,
      () => publishState(entry, page, { ...readBrowserState(page), loading: false, error: "ERR_BLOCKED_BY_CLIENT" }),
    )
    entry.win.contentView.addChildView(view)
    observeBrowserPage(
      page,
      (state, mainDocumentChanged) => publishState(entry, page, state, mainDocumentChanged),
      (reason) => failPage(entry, page, reason),
    )
    attachPage(entry, page, registration)
  }

  function attachPage(entry: Entry, page: BrowserPage, registration: BrowserRegistration) {
    const driver = entry.chromium<BrowserPage>((context) => createChromiumPort(page, context))
    page.ready = registration.attach({ driver, signal: page.abort.signal }).then(async (attachment) => {
      if (page.closed || entry.page !== page) {
        await attachment.close()
        throw new Error("browser.pane.attachment.closed")
      }
      page.attachment = attachment
      publishState(entry, page, { ...readBrowserState(page), ready: true })
      return attachment
    })
    void page.ready.catch((error: unknown) => failPage(entry, page, error))
  }

  function failPage(entry: Entry, page: BrowserPage, error: unknown) {
    if (entry.page !== page || page.closed) return
    entry.failure = error instanceof Error ? error.message : String(error)
    disposePage(entry)
    publish(
      entry,
      new BrowserPaneStateChanged({
        bindingID: entry.binding.bindingID,
        state: { ...initialState, error: entry.failure },
      }),
    )
  }

  function publishState(entry: Entry, page: BrowserPage, state: BrowserPaneState, mainDocumentChanged = false) {
    if (entry.page !== page || page.closed) return
    page.state = state
    page.listeners.forEach((listener) => listener({ state, mainDocumentChanged }))
    publish(entry, new BrowserPaneStateChanged({ bindingID: entry.binding.bindingID, state }))
  }

  function publish(entry: Entry, event: BrowserPaneOpened | BrowserPaneStateChanged) {
    if (!entry.closed && !entry.win.isDestroyed() && !entry.win.webContents.isDestroyed()) {
      emitIpcEvent(entry.win.webContents, event)
    }
  }
}

export type Controller = ReturnType<typeof createBrowserPane>

export class Service extends Context.Service<Service, Controller>()("opencode/desktop/BrowserPane") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const shutdown = yield* Shutdown.Service
    const browser = createBrowserPane()
    const stop = Effect.promise(() => browser.dispose())
    const removeShutdown = yield* shutdown.add(stop)
    yield* Effect.addFinalizer(() => Effect.sync(removeShutdown).pipe(Effect.andThen(stop)))
    return Service.of(browser)
  }),
)

function disposePage(entry: Entry) {
  const page = entry.page
  if (!page || page.closed) return
  entry.page = undefined
  page.closed = true
  page.abort.abort()
  page.listeners.clear()
  if (!entry.win.isDestroyed()) {
    page.view.setVisible(false)
    entry.win.contentView.removeChildView(page.view)
  }
  if (!page.view.webContents.isDestroyed()) page.view.webContents.close({ waitForBeforeUnload: false })
  void page.attachment?.close().catch(() => undefined)
}
