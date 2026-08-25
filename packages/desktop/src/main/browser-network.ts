import type { BrowserProxy } from "@opencode-ai/client/node"

export async function installBrowserNetwork(input: {
  readonly proxy: BrowserProxy
  readonly session: Electron.Session
  readonly webContents: Electron.WebContents
}) {
  let disposed = false
  const login = (
    event: Electron.Event,
    _details: Electron.LoginAuthenticationResponseDetails,
    authentication: Electron.AuthInfo,
    callback: (username?: string, password?: string) => void,
  ) => {
    if (
      !authentication.isProxy ||
      authentication.scheme !== "basic" ||
      authentication.host !== input.proxy.host ||
      authentication.port !== input.proxy.port ||
      authentication.realm !== "OpenCode Browser Proxy"
    ) {
      return
    }
    event.preventDefault()
    callback(input.proxy.credentials.username, input.proxy.credentials.password)
  }
  const dispose = () => {
    if (disposed) return
    disposed = true
    if (!input.webContents.isDestroyed()) input.webContents.off("login", login)
    void input.session.closeAllConnections().catch(() => undefined)
  }

  input.webContents.on("login", login)
  input.webContents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp")
  await input.session
    .setProxy({ mode: "fixed_servers", proxyRules: input.proxy.url, proxyBypassRules: "<-loopback>" })
    .then(() => input.session.closeAllConnections())
    .catch((error: unknown) => {
      dispose()
      throw error
    })
  return dispose
}
