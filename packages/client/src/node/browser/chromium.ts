import type { Browser } from "@opencode-ai/schema/browser"
import {
  BrowserDriverError,
  type BrowserDriver,
  type BrowserDriverContext,
  type BrowserDriverInstance,
} from "./driver.js"

type ViewState = Omit<Browser.State, "generation">
type Commands = {
  "Runtime.evaluate": { readonly expression: string }
  "Runtime.callFunctionOn": {
    readonly objectId: string
    readonly functionDeclaration: string
    readonly arguments?: ReadonlyArray<{ readonly value: string }>
    readonly returnByValue: true
  }
  "Runtime.releaseObject": { readonly objectId: string }
  "Input.dispatchMouseEvent": {
    readonly type: "mouseMoved" | "mousePressed" | "mouseReleased" | "mouseWheel"
    readonly x: number
    readonly y: number
    readonly button?: "left"
    readonly clickCount?: 1
    readonly deltaX?: number
    readonly deltaY?: number
  }
  "Input.dispatchKeyEvent": {
    readonly type: "keyDown" | "keyUp"
    readonly key: string
    readonly code: string
    readonly modifiers?: number
    readonly windowsVirtualKeyCode?: number
  }
  "Input.insertText": { readonly text: string }
}
type ChromiumCommand = {
  [Method in keyof Commands]: { readonly method: Method; readonly params: Commands[Method] }
}[keyof Commands]

export interface ChromiumPort<Resource> {
  readonly resource: Resource
  readonly state: () => ViewState
  readonly subscribe: (
    listener: (event: { readonly state: ViewState; readonly mainDocumentChanged: boolean }) => void,
  ) => () => void
  readonly navigate: (url: string) => PromiseLike<void>
  readonly back: () => PromiseLike<void> | void
  readonly forward: () => PromiseLike<void> | void
  readonly reload: () => PromiseLike<void> | void
  readonly stop: () => void
  readonly send: (command: ChromiumCommand) => PromiseLike<unknown>
  readonly viewport: () => { readonly width: number; readonly height: number }
  readonly screenshot: (maxDimension: number) => PromiseLike<{
    readonly data: Uint8Array
    readonly width: number
    readonly height: number
  }>
  readonly dispose: () => PromiseLike<void> | void
}

export interface ChromiumController<Resource> extends AsyncDisposable {
  readonly resource: Resource
  readonly state: () => Browser.State
  readonly subscribe: (listener: (state: Browser.State) => void) => () => void
  readonly navigate: (url: string) => Promise<void>
  readonly back: () => Promise<void>
  readonly forward: () => Promise<void>
  readonly reload: () => Promise<void>
  readonly stop: () => void
  readonly dispose: () => Promise<void>
}

export type ChromiumDriver<Resource> = BrowserDriver<ChromiumController<Resource>>

type SnapshotNode = {
  readonly token?: string
  readonly role: string
  readonly name: string
  readonly value: string
  readonly depth: number
  readonly checked?: boolean
  readonly disabled?: boolean
  readonly expanded?: boolean
  readonly selected?: boolean
}

type Page<Resource> = {
  readonly port: ChromiumPort<Resource>
  readonly lifetime: AbortSignal
  readonly refs: Set<string>
  readonly listeners: Set<(state: Browser.State) => void>
  state: ViewState
  generation: number
  nextRef: number
  snapshot?: string
  active?: AbortController
  unsubscribe?: () => void
  queue: Promise<void>
  disposed: boolean
  disposal?: Promise<void>
}

export function chromiumDriver<Resource>(
  create: (context: BrowserDriverContext) => PromiseLike<ChromiumPort<Resource>> | ChromiumPort<Resource>,
): ChromiumDriver<Resource> {
  return async (context) => {
    const port = await create(context)
    if (context.signal.aborted) {
      await port.dispose()
      throw context.signal.reason instanceof Error
        ? context.signal.reason
        : new Error("Chromium driver creation was aborted")
    }
    const page: Page<Resource> = {
      port,
      lifetime: context.signal,
      refs: new Set(),
      listeners: new Set(),
      state: port.state(),
      generation: 0,
      nextRef: 0,
      queue: Promise.resolve(),
      disposed: false,
    }
    page.unsubscribe = port.subscribe((event) => {
      if (page.disposed) return
      if (event.mainDocumentChanged) {
        page.generation++
        invalidate(page)
      }
      page.state = event.state
      page.listeners.forEach((listener) => listener(state(page)))
    })

    const dispose = () => {
      if (page.disposal) return page.disposal
      page.disposed = true
      page.active?.abort()
      page.listeners.clear()
      invalidate(page)
      page.unsubscribe?.()
      port.stop()
      page.disposal = Promise.resolve(port.dispose())
      return page.disposal
    }
    const action = (run: () => PromiseLike<void> | void) =>
      schedule(page, undefined, async (signal) => {
        if (signal.aborted) throw failure("aborted", "The browser action was aborted.")
        await run()
        if (signal.aborted) throw failure("aborted", "The browser action was aborted.")
      })
    const controller: ChromiumController<Resource> = Object.freeze({
      resource: port.resource,
      state: () => state(page),
      subscribe: (listener) => {
        if (page.disposed) throw failure("not_attached", "The browser page is no longer attached.")
        page.listeners.add(listener)
        listener(state(page))
        return () => page.listeners.delete(listener)
      },
      navigate: (url) => schedule(page, undefined, (signal) => navigate(page, url, signal)),
      back: () => action(() => port.back()),
      forward: () => action(() => port.forward()),
      reload: () => action(() => port.reload()),
      stop: () => {
        if (page.disposed) throw failure("not_attached", "The browser page is no longer attached.")
        page.active?.abort()
        port.stop()
      },
      dispose,
      [Symbol.asyncDispose]: dispose,
    })
    return Object.freeze({
      resource: controller,
      state: controller.state,
      subscribe: controller.subscribe,
      execute: (command: Browser.Command, options: { readonly signal: AbortSignal }) =>
        schedule(page, options.signal, (signal) => execute(page, command, signal)),
      dispose,
    }) satisfies BrowserDriverInstance<ChromiumController<Resource>>
  }
}

async function execute<Resource>(
  page: Page<Resource>,
  command: Browser.Command,
  signal: AbortSignal,
): Promise<Browser.Result> {
  assertGeneration(page, command.generation)
  if (command.type === "navigate") {
    await navigate(page, command.url, signal)
    return { type: "navigate", state: state(page) }
  }
  if (command.type === "snapshot") return snapshot(page, command.generation, signal)
  if (command.type === "screenshot") return screenshot(page, command.generation, signal)
  if (command.type === "click") await click(page, command.ref, command.generation, signal)
  if (command.type === "fill") await fill(page, command.ref, command.text, command.generation, signal)
  if (command.type === "press") await press(page, command.key, signal)
  if (command.type === "scroll") await scroll(page, command.direction, command.pixels, signal)
  assertGeneration(page, command.generation)
  return { type: command.type, state: refresh(page) }
}

async function navigate<Resource>(page: Page<Resource>, input: string, signal: AbortSignal) {
  const url = normalizeURL(input)
  const cancel = () => page.port.stop()
  signal.addEventListener("abort", cancel, { once: true })
  await bounded(() => page.port.navigate(url), signal, 30_000, "The browser navigation timed out.")
    .catch((error: unknown) => {
      if (signal.aborted || error instanceof BrowserDriverError) throw error
      throw failure("navigation_failed", error instanceof Error ? error.message : String(error))
    })
    .finally(() => signal.removeEventListener("abort", cancel))
  refresh(page)
}

function normalizeURL(input: string) {
  const value = input.trim()
  if (value.length > 16_384) throw failure("invalid_url", "The browser URL is too long.")
  if (!value || value === "about:blank") return "about:blank"
  if (/^(?:file|javascript|data|vbscript|blob|about):/i.test(value)) {
    throw failure("invalid_url", "Only HTTP, HTTPS, and about:blank URLs are supported.")
  }
  const local = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?(?:[/?#]|$)/i.test(value)
  const authority = /^(?:\[[^\]]+\]|[^:/?#\s]+):\d+(?:[/?#]|$)/.test(value)
  const candidate = local
    ? `http://${value}`
    : authority
      ? `https://${value}`
      : /^[a-z][a-z\d+.-]*:/i.test(value)
        ? value
        : `https://${value}`
  if (!URL.canParse(candidate)) throw failure("invalid_url", "Enter a valid HTTP or HTTPS URL.")
  const url = new URL(candidate)
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    throw failure("invalid_url", "Only HTTP, HTTPS, and about:blank URLs are supported.")
  }
  if (url.href.length > 16_384) throw failure("invalid_url", "The browser URL is too long.")
  return url.href
}

async function snapshot<Resource>(page: Page<Resource>, generation: number, signal: AbortSignal) {
  const object = await send(
    page,
    { method: "Runtime.evaluate", params: { expression: snapshotExpression(page.nextRef) } },
    signal,
  )
  if (!record(object) || !record(object.result) || typeof object.result.objectId !== "string") {
    throw failure("internal", "Browser page operation failed.")
  }
  const objectID = object.result.objectId
  const result = await callObject(page, objectID, "function() { return this.result }", signal)
    .then((value) => {
      const result = readSnapshot(value)
      assertGeneration(page, generation)
      return result
    })
    .catch((error: unknown) => {
      release(page, objectID)
      throw error
    })
  invalidate(page)
  page.snapshot = objectID
  page.nextRef = Math.max(page.nextRef, result.nextRef)
  result.nodes.forEach((node) => {
    if (node.token) page.refs.add(node.token)
  })
  return {
    type: "snapshot",
    state: refresh(page),
    format: "opencode.semantic.v1",
    content: formatSnapshot(page.port.state(), result.nodes),
  } as const
}

function readSnapshot(value: unknown) {
  if (
    !record(value) ||
    !Array.isArray(value.nodes) ||
    value.nodes.length > 500 ||
    !Number.isSafeInteger(value.nextRef) ||
    Number(value.nextRef) < 0
  ) {
    throw failure("internal", "Invalid browser snapshot response.")
  }
  const nodes = value.nodes.map((node): SnapshotNode => {
    if (
      !record(node) ||
      typeof node.role !== "string" ||
      !/^[a-zA-Z0-9_-]{1,40}$/.test(node.role) ||
      typeof node.name !== "string" ||
      typeof node.value !== "string" ||
      !Number.isSafeInteger(node.depth) ||
      Number(node.depth) < 0 ||
      Number(node.depth) > 6 ||
      (node.token !== undefined && (typeof node.token !== "string" || !/^e[1-9][0-9]*$/.test(node.token)))
    ) {
      throw failure("internal", "Invalid browser snapshot response.")
    }
    return node as SnapshotNode
  })
  return { nodes, nextRef: Number(value.nextRef) }
}

function formatSnapshot(current: ViewState, nodes: SnapshotNode[]) {
  const lines = nodes.map((node) => {
    const details = [
      node.name ? JSON.stringify(node.name) : undefined,
      node.value && node.value !== node.name ? `value=${JSON.stringify(node.value)}` : undefined,
    ]
    const flags = (["checked", "disabled", "expanded", "selected"] as const).map((flag) =>
      node[flag] === undefined ? undefined : `${flag}=${node[flag]}`,
    )
    const suffix = [...details, ...flags].filter((item): item is string => item !== undefined).join(" ")
    return `${"  ".repeat(node.depth)}${node.token ? `${node.token} ` : ""}[${node.role}]${suffix ? ` ${suffix}` : ""}`
  })
  return [
    `Page: ${current.title.replaceAll(/\s+/g, " ").trim().slice(0, 1_024)}`,
    `URL: ${current.url.slice(0, 16_384)}`,
    "",
    ...lines,
  ]
    .join("\n")
    .slice(0, 40 * 1_024)
}

async function click<Resource>(page: Page<Resource>, ref: Browser.Ref, generation: number, signal: AbortSignal) {
  const value = await callObject(page, resolveRef(page, ref), clickExpression, signal, ref)
  if (!record(value) || typeof value.x !== "number" || typeof value.y !== "number") {
    throw failure("stale_ref", "The browser element has no clickable bounds.")
  }
  assertGeneration(page, generation)
  const point = { x: value.x, y: value.y }
  await send(page, { method: "Input.dispatchMouseEvent", params: { type: "mouseMoved", ...point } }, signal)
  await send(
    page,
    {
      method: "Input.dispatchMouseEvent",
      params: { type: "mousePressed", button: "left", clickCount: 1, ...point },
    },
    signal,
  ).finally(() =>
    send(page, {
      method: "Input.dispatchMouseEvent",
      params: { type: "mouseReleased", button: "left", clickCount: 1, ...point },
    }),
  )
}

async function fill<Resource>(
  page: Page<Resource>,
  ref: Browser.Ref,
  text: string,
  generation: number,
  signal: AbortSignal,
) {
  const editable = await callObject(page, resolveRef(page, ref), fillExpression, signal, ref)
  assertGeneration(page, generation)
  if (editable !== true) throw failure("stale_ref", "The browser element is not editable. Call browser_snapshot again.")
  await keyPair(page, { key: "a", code: "KeyA", modifiers: process.platform === "darwin" ? 4 : 2 }, signal)
  await keyPair(page, { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 }, signal)
  await send(page, { method: "Input.insertText", params: { text } }, signal)
}

function press<Resource>(page: Page<Resource>, key: Browser.Key, signal: AbortSignal) {
  const code = (
    { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, Space: 32 } as Partial<Record<Browser.Key, number>>
  )[key]
  return keyPair(
    page,
    { key: key === "Space" ? " " : key, code: key, ...(code ? { windowsVirtualKeyCode: code } : {}) },
    signal,
  )
}

function scroll<Resource>(page: Page<Resource>, direction: Browser.Direction, pixels: number, signal: AbortSignal) {
  const viewport = page.port.viewport()
  const distance = Math.min(2_000, Math.max(1, pixels))
  return send(
    page,
    {
      method: "Input.dispatchMouseEvent",
      params: {
        type: "mouseWheel",
        x: Math.max(0, Math.round(viewport.width / 2)),
        y: Math.max(0, Math.round(viewport.height / 2)),
        deltaX: direction === "left" ? -distance : direction === "right" ? distance : 0,
        deltaY: direction === "up" ? -distance : direction === "down" ? distance : 0,
      },
    },
    signal,
  )
}

async function screenshot<Resource>(page: Page<Resource>, generation: number, signal: AbortSignal) {
  const source = await bounded(() => page.port.screenshot(2_000), signal, 10_000, "The browser screenshot timed out.")
  assertGeneration(page, generation)
  if (source.data.byteLength > 5 * 1_024 * 1_024)
    throw failure("result_too_large", "The browser screenshot exceeds 5 MiB.")
  if (
    ![source.width, source.height].every(
      (dimension) => Number.isSafeInteger(dimension) && dimension >= 1 && dimension <= 2_000,
    )
  ) {
    throw failure("internal", "The browser pane has no drawable area.")
  }
  return {
    type: "screenshot",
    state: refresh(page),
    mediaType: "image/png",
    data: new Uint8Array(source.data),
    width: source.width,
    height: source.height,
  } as const
}

function schedule<Resource, Result>(
  page: Page<Resource>,
  signal: AbortSignal | undefined,
  run: (signal: AbortSignal) => Promise<Result>,
) {
  if (page.disposed) throw failure("not_attached", "The browser page is no longer attached.")
  if (signal?.aborted) throw failure("aborted", "The browser action was aborted.")
  const result = page.queue.then(() => {
    if (page.disposed) throw failure("not_attached", "The browser page is no longer attached.")
    if (signal?.aborted) throw failure("aborted", "The browser action was aborted.")
    const active = new AbortController()
    page.active = active
    return run(AbortSignal.any([page.lifetime, active.signal, ...(signal ? [signal] : [])])).finally(() => {
      if (page.active === active) page.active = undefined
    })
  })
  page.queue = result.then(
    () => undefined,
    () => undefined,
  )
  return result.catch((error: unknown) => {
    throw error instanceof BrowserDriverError
      ? error
      : failure("internal", error instanceof Error ? error.message : String(error))
  })
}

function state<Resource>(page: Page<Resource>): Browser.State {
  if (page.disposed) throw failure("not_attached", "The browser page is no longer attached.")
  return {
    url: page.state.url.slice(0, 16_384),
    title: page.state.title.slice(0, 1_024),
    loading: page.state.loading,
    canGoBack: page.state.canGoBack,
    canGoForward: page.state.canGoForward,
    generation: page.generation,
  }
}

function refresh<Resource>(page: Page<Resource>) {
  page.state = page.port.state()
  const current = state(page)
  page.listeners.forEach((listener) => listener(current))
  return current
}

function invalidate<Resource>(page: Page<Resource>) {
  if (page.snapshot) release(page, page.snapshot)
  page.snapshot = undefined
  page.refs.clear()
}

function release<Resource>(page: Page<Resource>, objectID: string) {
  void Promise.resolve(page.port.send({ method: "Runtime.releaseObject", params: { objectId: objectID } })).catch(
    () => undefined,
  )
}

function resolveRef<Resource>(page: Page<Resource>, ref: Browser.Ref) {
  if (!page.snapshot || !page.refs.has(ref))
    throw failure("stale_ref", "The element reference is stale. Call browser_snapshot again.")
  return page.snapshot
}

function send<Resource>(page: Page<Resource>, command: ChromiumCommand, signal?: AbortSignal) {
  return bounded(() => page.port.send(command), signal, 10_000, "The browser command timed out.").catch(
    (error: unknown) => {
      if (stale(error)) throw failure("stale_ref", "The element reference is stale. Call browser_snapshot again.")
      throw error
    },
  )
}

function callObject<Resource>(
  page: Page<Resource>,
  objectID: string,
  expression: string,
  signal: AbortSignal,
  token?: Browser.Ref,
) {
  return send(
    page,
    {
      method: "Runtime.callFunctionOn",
      params: {
        objectId: objectID,
        functionDeclaration: expression,
        ...(token ? { arguments: [{ value: token }] } : {}),
        returnByValue: true,
      },
    },
    signal,
  ).then(runtimeValue)
}

function runtimeValue(input: unknown): unknown {
  if (!record(input)) throw failure("internal", "Browser page operation failed.")
  if (input.exceptionDetails !== undefined) {
    const details = record(input.exceptionDetails) ? input.exceptionDetails : undefined
    const exception = details && record(details.exception) ? details.exception : undefined
    const message =
      (exception && typeof exception.description === "string" && exception.description) ||
      (details && typeof details.text === "string" && details.text) ||
      "Browser page operation failed."
    throw stale(message)
      ? failure("stale_ref", "The element reference is stale. Call browser_snapshot again.")
      : failure("internal", message)
  }
  if (!record(input.result) || !("value" in input.result)) throw failure("internal", "Browser page operation failed.")
  return input.result.value
}

function keyPair<Resource>(
  page: Page<Resource>,
  key: Omit<Commands["Input.dispatchKeyEvent"], "type">,
  signal: AbortSignal,
) {
  return send(page, { method: "Input.dispatchKeyEvent", params: { type: "keyDown", ...key } }, signal).finally(() =>
    send(page, { method: "Input.dispatchKeyEvent", params: { type: "keyUp", ...key } }),
  )
}

function assertGeneration<Resource>(page: Page<Resource>, generation: number) {
  if (page.generation !== generation)
    throw failure("stale_ref", "The browser page changed. Call browser_snapshot again.")
}

function bounded<Result>(
  run: () => PromiseLike<Result>,
  signal: AbortSignal | undefined,
  timeout: number,
  message: string,
) {
  if (signal?.aborted) return Promise.reject(failure("aborted", "The browser action was aborted."))
  const timedOut = AbortSignal.timeout(timeout)
  const abort = signal ? AbortSignal.any([signal, timedOut]) : timedOut
  return new Promise<Result>((resolve, reject) => {
    const cancel = () =>
      reject(timedOut.aborted ? failure("timeout", message) : failure("aborted", "The browser action was aborted."))
    abort.addEventListener("abort", cancel, { once: true })
    void Promise.resolve()
      .then(run)
      .then(resolve, reject)
      .finally(() => abort.removeEventListener("abort", cancel))
  })
}

function failure(code: Browser.ErrorCode, message: string) {
  return new BrowserDriverError(code, message.slice(0, 1_024))
}

function stale(input: unknown) {
  return /Could not find (node|object)|No node with given id|Node with given id does not belong|Could not push node|Could not compute box model|stale element/i.test(
    input instanceof Error ? input.message : String(input),
  )
}

function record(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input)
}

function snapshotExpression(nextRef: number) {
  return `(() => {
    const interactive = new Set(["button","checkbox","combobox","link","menuitem","option","radio","searchbox","slider","spinbutton","switch","tab","textbox"])
    const readable = new Set(["article","cell","columnheader","heading","img","list","listitem","p","region","row","rowheader","table"])
    const roleFor = (element) => {
      const explicit = element.getAttribute("role")
      if (explicit) return explicit.slice(0, 100).split(/\\s+/)[0]
      if (/^H[1-6]$/.test(element.tagName)) return "heading"
      if (element.tagName === "INPUT") {
        return ({checkbox:"checkbox",radio:"radio",range:"slider",number:"spinbutton",search:"searchbox"})[element.type] || "textbox"
      }
      return ({A:"link",ARTICLE:"article",BUTTON:"button",IMG:"img",LI:"listitem",OL:"list",P:"p",SELECT:"combobox",TABLE:"table",TD:"cell",TH:"columnheader",TR:"row",TEXTAREA:"textbox",UL:"list"})[element.tagName] || element.tagName.toLowerCase()
    }
    const clean = (value) => String(value || "").slice(0, 1000).replace(/\\s+/g, " ").trim().slice(0, 300)
    const textFor = (element) => {
      const queue = Array.from(element.childNodes).slice(0, 20)
      const parts = []
      let visited = 0
      while (queue.length && visited++ < 20) {
        const item = queue.shift()
        if (item.nodeType === Node.TEXT_NODE) parts.push(item.nodeValue || "")
        queue.push(...Array.from(item.childNodes).slice(0, Math.max(0, 20 - queue.length - visited)))
      }
      return parts.join(" ")
    }
    const nodes = []
    const refs = Object.create(null)
    const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_ELEMENT)
    let visited = 0
    let ref = ${Math.max(0, Math.floor(nextRef))}
    while (visited++ < 500) {
      const element = walker.nextNode()
      if (!element) break
      if (element.hidden || element.getAttribute("aria-hidden") === "true" || (element.tagName === "INPUT" && element.type === "hidden")) continue
      const role = clean(roleFor(element)).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40) || "node"
      const isInteractive = interactive.has(role) || element.tabIndex >= 0
      if (!isInteractive && !readable.has(role)) continue
      const editable = ["INPUT","TEXTAREA","SELECT"].includes(element.tagName) || ["textbox","searchbox","combobox","spinbutton"].includes(role) || element.isContentEditable
      const labelledBy = element.getAttribute("aria-labelledby")
      const label = labelledBy && document.getElementById(labelledBy)
      const token = isInteractive ? "e" + (++ref) : undefined
      if (token) refs[token] = element
      let depth = 0
      for (let item = element.parentElement; item && depth < 6; item = item.parentElement) depth++
      nodes.push({
        token,
        role,
        name: clean(element.getAttribute("aria-label") || (label && textFor(label)) || element.alt || (editable ? "" : textFor(element))),
        value: editable ? "" : clean(element.value),
        depth,
        checked: "checked" in element ? Boolean(element.checked) : undefined,
        disabled: "disabled" in element ? Boolean(element.disabled) : undefined,
        expanded: element.getAttribute("aria-expanded") === "true" ? true : element.getAttribute("aria-expanded") === "false" ? false : undefined,
        selected: "selected" in element ? Boolean(element.selected) : undefined,
      })
    }
    return { result: { nodes, nextRef: ref }, refs }
  })()`
}

const clickExpression = `function(token) {
  const element = this.refs[token]
  if (!element || !element.isConnected) throw new Error("stale element")
  element.scrollIntoView({ block: "center", inline: "center" })
  const bounds = element.getBoundingClientRect()
  if (bounds.width <= 0 || bounds.height <= 0) throw new Error("element has no bounds")
  return { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 }
}`

const fillExpression = `function(token) {
  const element = this.refs[token]
  if (!element || !element.isConnected) throw new Error("stale element")
  const role = String(element.getAttribute("role") || "").split(/\\s+/, 1)[0]
  const input = element.tagName === "INPUT" && !["button","checkbox","color","file","hidden","image","radio","range","reset","submit"].includes(String(element.type).toLowerCase())
  const editable = input || element.tagName === "TEXTAREA" || element.isContentEditable || ["textbox","searchbox","combobox","spinbutton"].includes(role)
  if (!editable || element.disabled || element.readOnly || element.getAttribute("aria-disabled") === "true" || element.getAttribute("aria-readonly") === "true") return false
  element.focus()
  return true
}`
