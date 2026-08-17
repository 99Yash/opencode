import { For, Show } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { DialogBody, DialogHeader, DialogTitle, DialogV2 } from "@opencode-ai/ui/v2/dialog-v2"
import { ProjectAvatar } from "@opencode-ai/ui/v2/project-avatar-v2"
import { useGlobal } from "@/context/global"
import { useLanguage } from "@/context/language"
import { ServerConnection, serverName } from "@/context/servers"
import { displayName } from "@/pages/layout/helpers"

export function DialogOpenRecentProjects() {
  const global = useGlobal()
  const dialog = useDialog()
  const language = useLanguage()
  const navigate = useNavigate()
  const groups = () =>
    global.servers
      .list()
      .map((server) => ({ server, projects: global.ensureServerCtx(server).projects.recent() }))
      .filter((group) => group.projects.length > 0)

  const open = (server: ServerConnection.Any, directory: string) => {
    const ctx = global.ensureServerCtx(server)
    const location = { directory }
    void ctx.sdk.api.file
      .list({ path: ".", location })
      .then(() => ctx.sdk.api.project.current({ location }))
      .then((project) => ctx.sync.child(directory, { bootstrap: false })[1]("project", project.id))
      .catch(() => undefined)
    ctx.projects.open(directory)
    ctx.projects.touch(directory)
    dialog.close()
    navigate("/")
  }

  return (
    <DialogV2 fit containerClass="!h-auto max-h-[calc(100vh_-_16px)] !w-[min(calc(100vw_-_16px),560px)]">
      <DialogHeader closeLabel={language.t("common.close")}>
        <DialogTitle>{language.t("desktop.menu.openRecentProjects")}</DialogTitle>
      </DialogHeader>
      <DialogBody class="max-h-[calc(100vh_-_68px)] min-h-0 flex-none gap-3 overflow-y-auto px-2 pb-2">
        <For each={groups()}>
          {(group) => (
            <section class="flex min-w-0 flex-col">
              <Show when={global.servers.list().length > 1}>
                <div class="flex h-8 items-center px-3 text-[13px] text-v2-text-text-muted">
                  {serverName(group.server)}
                </div>
              </Show>
              <For each={group.projects}>
                {(project) => (
                  <button
                    type="button"
                    class="flex h-9 w-full min-w-0 items-center gap-2 rounded-md px-3 text-left text-[13px] text-v2-text-text-base hover:bg-v2-overlay-simple-overlay-hover focus:bg-v2-overlay-simple-overlay-hover focus:outline-none"
                    onClick={() => open(group.server, project.worktree)}
                  >
                    <ProjectAvatar fallback={displayName(project)} variant="outline" />
                    <span class="min-w-0 flex-1 truncate">{displayName(project)}</span>
                    <span class="max-w-1/2 truncate text-v2-text-text-muted">{project.worktree}</span>
                  </button>
                )}
              </For>
            </section>
          )}
        </For>
      </DialogBody>
    </DialogV2>
  )
}
