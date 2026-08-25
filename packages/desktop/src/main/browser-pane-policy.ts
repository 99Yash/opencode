export function configureBrowserPage(
  contents: Electron.WebContents,
  approvedOrigin: () => string,
  blocked: (url: string) => void,
) {
  const session = contents.session
  session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  session.setPermissionCheckHandler(() => false)
  session.setDevicePermissionHandler(() => false)
  session.setDisplayMediaRequestHandler((_request, callback) => callback({}))
  session.on("will-download", (event) => event.preventDefault())
  contents.setWindowOpenHandler(() => ({ action: "deny" }))
  contents.on("content-bounds-updated", (event) => event.preventDefault())
  const guard = (event: Electron.Event<{ url: string; isMainFrame: boolean }>) => {
    if (!event.isMainFrame || allowedDestination(event.url, approvedOrigin())) return
    event.preventDefault()
    blocked(event.url)
  }
  contents.on("will-navigate", guard)
  contents.on("will-redirect", guard)
}

export function destinationOrigin(input: string) {
  if (!URL.canParse(input)) return undefined
  const url = new URL(input)
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return undefined
  return url.origin
}

export function allowedDestination(input: string, approvedOrigin: string) {
  return input === "about:blank" || destinationOrigin(input) === approvedOrigin
}

export function normalizeBounds(
  input: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
  parent: { readonly width: number; readonly height: number },
) {
  if (![input.x, input.y, input.width, input.height, parent.width, parent.height].every(Number.isFinite)) return
  if (input.width <= 0 || input.height <= 0 || parent.width <= 0 || parent.height <= 0) return
  const x = Math.max(0, Math.min(Math.round(input.x), parent.width))
  const y = Math.max(0, Math.min(Math.round(input.y), parent.height))
  const right = Math.max(x, Math.min(Math.round(input.x + input.width), parent.width))
  const bottom = Math.max(y, Math.min(Math.round(input.y + input.height), parent.height))
  if (right === x || bottom === y) return
  return { x, y, width: right - x, height: bottom - y }
}
