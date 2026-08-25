import type { BrowserPaneState } from "@opencode-ai/app/desktop"
import type {
  BrowserAttachment,
  BrowserDriverContext,
  ChromiumController,
  ChromiumPort,
} from "@opencode-ai/client/node"
import type { WebContentsView } from "electron"
import { installBrowserNetwork } from "./browser-network"
import { destinationOrigin } from "./browser-pane-policy"

export type BrowserPageEvent = { readonly state: BrowserPaneState; readonly mainDocumentChanged: boolean }
export type BrowserPage = {
  readonly view: WebContentsView
  readonly abort: AbortController
  readonly listeners: Set<(event: BrowserPageEvent) => void>
  approvedOrigin: string
  state: BrowserPaneState
  closed: boolean
  attachment?: BrowserAttachment<ChromiumController<BrowserPage>>
  ready?: Promise<BrowserAttachment<ChromiumController<BrowserPage>>>
}

export async function createChromiumPort(page: BrowserPage, context: BrowserDriverContext) {
  const contents = page.view.webContents
  const cleanup = await installBrowserNetwork({
    proxy: context.proxy,
    session: contents.session,
    webContents: contents,
  })
  await contents.loadURL("about:blank").catch((error: unknown) => {
    cleanup()
    throw error
  })
  if (context.signal.aborted) {
    cleanup()
    context.signal.throwIfAborted()
  }

  return {
    resource: page,
    state: () => readBrowserState(page),
    subscribe(listener) {
      page.listeners.add(listener)
      return () => page.listeners.delete(listener)
    },
    navigate(url) {
      const origin = url === "about:blank" ? url : destinationOrigin(url)
      if (!origin) throw new Error("browser.pane.destination.invalid")
      page.approvedOrigin = origin
      return contents.loadURL(url)
    },
    back: () => navigateHistory(page, -1),
    forward: () => navigateHistory(page, 1),
    reload: () => contents.reload(),
    stop: () => {
      if (!contents.isDestroyed()) contents.stop()
    },
    send(command) {
      if (page.closed || contents.isDestroyed()) throw new Error("browser.pane.attachment.closed")
      if (!contents.debugger.isAttached()) contents.debugger.attach("1.3")
      return contents.debugger.sendCommand(command.method, command.params)
    },
    viewport: () => page.view.getBounds(),
    async screenshot(maximum) {
      const source = await contents.capturePage()
      const size = source.getSize()
      const scale = Math.min(1, Math.floor(maximum) / Math.max(size.width, size.height))
      const image =
        scale < 1
          ? source.resize({
              width: Math.max(1, Math.round(size.width * scale)),
              height: Math.max(1, Math.round(size.height * scale)),
              quality: "good",
            })
          : source
      return { data: new Uint8Array(image.toPNG()), ...image.getSize() }
    },
    dispose: cleanup,
  } satisfies ChromiumPort<BrowserPage>
}

export function observeBrowserPage(
  page: BrowserPage,
  publish: (state: BrowserPaneState, mainDocumentChanged?: boolean) => void,
  fail: (reason: string) => void,
) {
  const contents = page.view.webContents
  const update = () => publish(readBrowserState(page))
  contents.on("did-start-loading", update)
  contents.on("did-stop-loading", update)
  contents.on("did-navigate", update)
  contents.on("did-navigate-in-page", update)
  contents.on("page-title-updated", update)
  contents.on("did-fail-load", (_event, code, description, url, mainFrame) => {
    if (mainFrame && code !== -3) publish({ ...readBrowserState(page), url, loading: false, error: description })
  })
  contents.on("did-start-navigation", (event) => {
    if (!event.isMainFrame) return
    delete page.state.error
    publish({ ...readBrowserState(page), url: event.url, loading: true }, !event.isSameDocument)
  })
  contents.on("render-process-gone", (_event, details) => fail(details.reason))
  contents.debugger.on("detach", (_event, reason) => fail(reason))
}

export function readBrowserState(page: BrowserPage): BrowserPaneState {
  const contents = page.view.webContents
  if (contents.isDestroyed()) return { ...page.state, loading: false }
  return {
    url: contents.getURL(),
    title: contents.getTitle(),
    loading: contents.isLoading(),
    canGoBack: contents.navigationHistory.canGoBack(),
    canGoForward: contents.navigationHistory.canGoForward(),
    ready: page.state.ready ?? false,
    ...(page.state.error ? { error: page.state.error } : {}),
  }
}

function navigateHistory(page: BrowserPage, offset: -1 | 1) {
  const history = page.view.webContents.navigationHistory
  if (!history.canGoToOffset(offset)) return
  const url = history.getAllEntries()[history.getActiveIndex() + offset]?.url
  const origin = url === "about:blank" ? url : url && destinationOrigin(url)
  if (!origin) throw new Error("browser.pane.destination.invalid")
  page.approvedOrigin = origin
  history.goToOffset(offset)
}
