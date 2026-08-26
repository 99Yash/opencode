import { useLocation, useNavigate } from "@solidjs/router"
import { useLayout } from "@/shell/state/layout"
import { useTabs } from "@/shell/tabs/tabs"
import { useGlobal } from "@/runtime/server/runtime"
import { ServerConnection } from "@/runtime/server/registry"

export function useSettingsNavigation() {
  const location = useLocation<{ settings?: boolean }>()
  const navigate = useNavigate()
  const layout = useLayout()
  const tabs = useTabs()
  const global = useGlobal()

  return {
    open(tab = "general") {
      const route = layout.route()
      const query = new URLSearchParams(route.type === "settings" ? location.search : "")
      query.set("tab", tab)
      if (route.type !== "settings") {
        const draft = route.type === "draft" ? tabs.draft(route.draftID) : undefined
        const server = route.type === "session" ? route.server : (draft?.server ?? layout.home.selection().server)
        const connection = global.servers.list().find((item) => ServerConnection.key(item) === server)
        const directory =
          route.type === "session" && connection
            ? global.ensureServerCtx(connection).data.session.get(route.sessionId)?.location.directory
            : draft?.directory
        query.set("server", server)
        if (directory) query.set("directory", directory)
      }
      navigate(`/settings?${query}`, {
        replace: route.type === "settings",
        state: route.type === "settings" ? location.state : { settings: true },
      })
    },
    close() {
      if (layout.route().type !== "settings") return
      if (location.state?.settings) {
        navigate(-1)
        return
      }
      navigate("/", { replace: true })
    },
  }
}
