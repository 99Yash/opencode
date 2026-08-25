export type BrowserPaneTarget = Readonly<{ sessionID: string }>

export type BrowserPaneEndpoint = Readonly<{ url: string; username?: string; password?: string }>

export type BrowserPaneBinding = BrowserPaneTarget & Readonly<{ bindingID: string; endpoint: BrowserPaneEndpoint }>

export type BrowserPaneBounds = { x: number; y: number; width: number; height: number }

export type BrowserPaneLayout = {
  visible: boolean
  bounds?: BrowserPaneBounds
}

export type BrowserPaneCommand =
  | { type: "navigate"; url: string }
  | { type: "back" }
  | { type: "forward" }
  | { type: "reload" }
  | { type: "stop" }

export type BrowserPaneState = {
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  error?: string
  ready?: boolean
}

export type BrowserPaneRegistration = {
  setLayout(layout?: BrowserPaneLayout): void
  command(command: BrowserPaneCommand): Promise<void>
  subscribe(listener: (state: BrowserPaneState) => void): Promise<() => void>
  close(): void
}

export type BrowserPanePlatform = {
  register(binding: BrowserPaneBinding, onOpen: () => void): BrowserPaneRegistration
}

export function browserPaneAvailable(input: {
  platform: boolean
  enabled: boolean
  ready: boolean
  renderable: boolean
  sessionID?: string
  supported: boolean
}) {
  return input.platform && input.enabled && input.ready && input.renderable && !!input.sessionID && input.supported
}

export function createBrowserPaneBinding(input: BrowserPaneTarget & { endpoint: BrowserPaneEndpoint }) {
  return {
    sessionID: input.sessionID,
    bindingID: globalThis.crypto.randomUUID(),
    endpoint: input.endpoint,
  } satisfies BrowserPaneBinding
}
