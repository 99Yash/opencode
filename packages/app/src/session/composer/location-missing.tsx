import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { DockShell, DockTray } from "@opencode-ai/ui/dock-surface"
import { Icon } from "@opencode-ai/ui/icon"
import { Menu } from "@opencode-ai/ui/menu"
import { getFilename } from "@opencode-ai/util/path"
import { createEffect, createResource, For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/runtime/i18n/language"
import { useServerSDK } from "@/runtime/server/client"
import { useData } from "@/runtime/server/current"
import { showToast } from "@/shell/notifications/toast"
import { useDirectoryPicker } from "@/workspaces/selection/picker"
import { createWorktree } from "@/workspaces/create"

export function SessionLocationMissing(props: { sessionID: string; projectID: string; directory: string }) {
  const language = useLanguage()
  const sdk = useServerSDK()
  const data = useData()
  const dialog = useDialog()
  const pickDirectory = useDirectoryPicker()
  const [state, setState] = createStore({ moving: false, restoreFocus: false, worktreesOpen: false })
  const project = () => data.project.get(props.projectID)
  const [worktrees] = createResource(
    () => (state.worktreesOpen ? props.projectID : undefined),
    async (projectID) => {
      try {
        await sdk.api.worktree.refresh({ projectID })
        return await sdk.api.worktree.list({ projectID })
      } catch {
        showToast({ variant: "error", title: language.t("session.location.worktreesFailed") })
        return []
      }
    },
  )
  let button: HTMLButtonElement | undefined

  createEffect(() => {
    if (!state.restoreFocus || state.moving || dialog.active) return
    setState("restoreFocus", false)
    button?.focus()
  })

  async function move(sessionID: string, directory?: string) {
    setState("moving", true)
    try {
      // A deleted worktree cannot resolve its own location. Create from the
      // project's saved canonical checkout instead.
      const current = project()
      const destination =
        directory ??
        (current &&
          (await createWorktree({
            api: sdk.api,
            directory: current.canonical,
            project: { id: current.id, canonical: current.canonical, directory: current.canonical },
          })))
      if (!destination) return
      await sdk.api.session.move({ sessionID, directory: destination })
    } catch (error) {
      setState("restoreFocus", true)
      showToast({
        variant: "error",
        title: language.t("workspace.move.failed"),
        description: error instanceof Error ? error.message : language.t("common.requestFailed"),
      })
    } finally {
      setState("moving", false)
    }
  }

  function choose() {
    if (state.moving) return
    const sessionID = props.sessionID
    pickDirectory({
      server: sdk.server,
      title: language.t("session.location.choose"),
      onSelect: (result) => {
        const directory = Array.isArray(result) ? result[0] : result
        if (directory) void move(sessionID, directory)
        if (!directory) setState("restoreFocus", true)
      },
    })
  }

  return (
    <div data-component="session-location-missing">
      <DockShell class="flex flex-col gap-2 p-3">
        <div role="status" class="flex items-start gap-2 text-13-regular leading-[var(--line-height-base)]">
          <Icon name="warning" class="shrink-0 text-icon-warning-base" />
          <div class="min-w-0 flex flex-col gap-1">
            <div class="font-medium text-text-strong">{language.t("session.location.unavailable")}</div>
            <div class="break-all font-mono text-12-regular text-text-weak">{props.directory}</div>
            <div class="text-text-base">{language.t("session.location.description")}</div>
          </div>
        </div>
      </DockShell>
      <DockTray class="flex flex-wrap justify-end gap-2 p-2">
        <Show when={project()?.vcs === "git"}>
          <Menu placement="top-end" onOpenChange={(open) => setState("worktreesOpen", open)}>
            <Menu.Trigger as={Button} variant="neutral" disabled={state.moving}>
              {language.t("session.location.worktree")}
            </Menu.Trigger>
            <Menu.Portal>
              <Menu.Content class="max-h-80 max-w-[calc(100vw-32px)] overflow-y-auto">
                <Menu.Item onSelect={() => void move(props.sessionID)} disabled={state.moving}>
                  <Icon name="workspace-new" />
                  {language.t("workspace.new")}
                </Menu.Item>
                <Show when={worktrees.loading}>
                  <Menu.Item disabled>{language.t("common.loading")}</Menu.Item>
                </Show>
                <For each={worktrees()?.filter((item) => item.strategy && item.directory !== props.directory)}>
                  {(worktree) => (
                    <Menu.Item
                      title={worktree.directory}
                      onSelect={() => void move(props.sessionID, worktree.directory)}
                      disabled={state.moving}
                    >
                      <Icon name="workspace-isolated" />
                      <span class="truncate">{getFilename(worktree.directory)}</span>
                    </Menu.Item>
                  )}
                </For>
              </Menu.Content>
            </Menu.Portal>
          </Menu>
        </Show>
        <Button ref={button} variant="contrast" onClick={choose} disabled={state.moving}>
          {language.t(state.moving ? "session.location.moving" : "session.location.choose")}
        </Button>
      </DockTray>
    </div>
  )
}
