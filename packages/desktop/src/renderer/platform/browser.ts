import type { BrowserPanePlatform } from "@opencode-ai/app/desktop"
import type { ElectronAPI } from "../api-types"

export function createDesktopBrowser(api: ElectronAPI): BrowserPanePlatform {
  return {
    register(binding, onOpen) {
      let closed = false
      const ready = api.browserPane.register(binding)
      const disposeOpen = api.browserPane.onOpen((event) => {
        if (!closed && event.bindingID === binding.bindingID) onOpen()
      })
      return {
        setLayout(layout) {
          if (closed) return
          void ready.then(() => api.browserPane.setLayout(binding.bindingID, layout)).catch(() => undefined)
        },
        command: (command) => ready.then(() => api.browserPane.command(binding.bindingID, command)),
        async subscribe(listener) {
          const dispose = api.browserPane.onState((event) => {
            if (!closed && event.bindingID === binding.bindingID) listener(event.state)
          })
          const state = await ready
            .then(() => api.browserPane.state(binding.bindingID))
            .catch((error: unknown) => {
              dispose()
              throw error
            })
          if (closed) {
            dispose()
            return () => undefined
          }
          listener(state)
          return dispose
        },
        close() {
          if (closed) return
          closed = true
          disposeOpen()
          void ready.then(() => api.browserPane.unregister(binding.bindingID)).catch(() => undefined)
        },
      }
    },
  }
}
