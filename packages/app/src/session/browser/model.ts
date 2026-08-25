import { createEffect, createMemo, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import {
  browserPaneAvailable,
  createBrowserPaneBinding,
  type BrowserPaneRegistration,
} from "@/runtime/platform/browser-pane"
import { usePlatform } from "@/runtime/platform/platform"
import { useServer } from "@/runtime/server/current"
import { useSettings } from "@/settings/model"
import { useLayout } from "@/shell/state/layout"
import type { SessionModel } from "../model"

export function createSessionBrowser(session: SessionModel) {
  const platform = usePlatform()
  const settings = useSettings()
  const server = useServer()
  const layout = useLayout()
  const [state, setState] = createStore({
    opened: false,
    registration: undefined as BrowserPaneRegistration | undefined,
  })
  const available = createMemo(() =>
    browserPaneAvailable({
      platform: !!platform.browserPane,
      enabled: settings.general.experimentalBrowser(),
      ready: settings.ready(),
      renderable: session.isDesktop(),
      sessionID: session.identity.sessionID(),
      supported: !server.health?.incompatible,
    }),
  )
  const binding = createMemo(() => {
    const sessionID = session.identity.sessionID()
    if (!available() || !sessionID) return undefined
    return createBrowserPaneBinding({ sessionID, endpoint: server.conn.http })
  })

  const open = () => {
    session.layout.view().reviewPanel.close()
    layout.fileTree.close()
    setState("opened", true)
  }

  createEffect(() => {
    const current = binding()
    if (!current || !platform.browserPane) {
      setState({ opened: false, registration: undefined })
      return
    }

    const owner = session.ownership.capture()
    const registration = platform.browserPane.register(current, () => owner.run(open))
    setState({ opened: false, registration })
    onCleanup(() => registration.close())
  })

  createEffect(() => {
    if (!state.opened) return
    if (!session.layout.view().reviewPanel.opened() && !layout.fileTree.opened()) return
    setState("opened", false)
  })

  return {
    available,
    opened: () => state.opened,
    registration: () => (state.opened ? state.registration : undefined),
    close: () => setState("opened", false),
    toggle: () => (state.opened ? setState("opened", false) : open()),
  }
}
