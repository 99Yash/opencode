import { useDirectoryPicker } from "@/components/directory-picker"
import { useServerManagementController } from "@/components/dialog-select-server"
import { useSettingsCommand } from "@/components/settings-dialog"
import { DialogServerV2 } from "@/components/settings-v2/dialog-server-v2"
import { useGlobal } from "@/context/global"
import { type HomeProjectSelection, type LocalProject, useLayout } from "@/context/layout"
import { useLanguage } from "@/context/language"
import { useNotification } from "@/context/notification"
import { usePlatform } from "@/context/platform"
import { ServerConnection, useServer } from "@/context/server"
import { useServerSync } from "@/context/server-sync"
import { useTabs } from "@/context/tabs"
import {
  closeHomeProject,
  errorMessage,
  homeProjectDirectories,
  toggleHomeProjectSelection,
} from "@/pages/layout/helpers"
import { fileManagerApp } from "@/utils/file-manager"
import { Persist, persisted } from "@/utils/persist"
import { showToast } from "@/utils/toast"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { createEffect, createMemo, createResource } from "solid-js"
import { createStore } from "solid-js/store"

export function createHomeProjectsController() {
  const sync = useServerSync()
  const layout = useLayout()
  const platform = usePlatform()
  const pickDirectory = useDirectoryPicker()
  const dialog = useDialog()
  const server = useServer()
  const language = useLanguage()
  const global = useGlobal()
  const tabs = useTabs()
  const notification = useNotification()
  const openSettings = useSettingsCommand()
  const serverManagement = useServerManagementController({ navigateOnAdd: false })
  const [menu, setMenu] = createStore({ open: undefined as string | undefined })
  const [_state, setState, _, ready] = persisted(
    Persist.global("home.servers", ["home.servers.v1"]),
    createStore({ collapsed: {} as Record<string, boolean> }),
  )
  const [state] = createResource(
    () => ready.promise ?? Promise.resolve(),
    (promise) => promise.then(() => _state),
    { initialValue: _state },
  )
  const selection = layout.home.selection
  const focusedServer = createMemo(
    () => global.servers.list().find((conn) => ServerConnection.key(conn) === selection().server) ?? server.current,
  )
  const focusedServerCtx = createMemo(() => {
    const conn = focusedServer()
    if (!conn) return undefined
    return global.ensureServerCtx(conn)
  })
  const focusedSync = () => focusedServerCtx()?.sync ?? sync()
  const projects = createMemo(() => focusedServerCtx()?.projects.list() ?? layout.projects.list())
  const recentlyClosed = createMemo(
    () => focusedServerCtx()?.projects.recentlyClosed() ?? layout.projects.recentlyClosed(),
  )
  const homedir = createMemo(() => focusedSync().data.path.home ?? "")
  const selectedProject = createMemo(() => projects().find((project) => project.worktree === selection().directory))
  const newSessionProject = createMemo(
    () =>
      selectedProject() ??
      projects().find((project) => project.worktree === focusedServerCtx()?.projects.last()) ??
      projects()[0],
  )

  createEffect(() => {
    const id = menu.open
    if (!id) return
    const connections = global.servers.list()
    const valid = connections.some((conn) => {
      if (serverMenuID(conn) === id) return true
      if (
        connections.length > 1 &&
        (global.servers.health[ServerConnection.key(conn)]?.healthy !== true || collapsed(conn))
      )
        return false
      const list = connections.length === 1 ? projects() : projectsForServer(conn)
      return list.some((project) => projectMenuID(conn, project.worktree) === id)
    })
    if (!valid) setMenu("open", undefined)
  })

  createEffect(() => {
    const list = global.servers.list()
    if (list.some((conn) => ServerConnection.key(conn) === selection().server)) return
    const conn = list.find((conn) => ServerConnection.key(conn) === server.key) ?? list[0]
    if (conn) setSelection({ server: ServerConnection.key(conn) })
  })

  function setSelection(next: HomeProjectSelection) {
    layout.home.setSelection(next)
  }

  function focusServer(conn: ServerConnection.Any) {
    setSelection({ server: ServerConnection.key(conn) })
  }

  function selectProject(conn: ServerConnection.Any, directory: string) {
    const key = ServerConnection.key(conn)
    if (global.servers.health[key]?.healthy === false) return
    if (
      !global
        .ensureServerCtx(conn)
        .projects.list()
        .some((project) => project.worktree === directory)
    )
      return
    setSelection(toggleHomeProjectSelection(selection(), key, directory))
  }

  function addProjects(conn: ServerConnection.Any, directories: string[]) {
    const directory = directories[0]
    if (!directory) return
    const ctx = global.ensureServerCtx(conn)
    directories.forEach((item) => ctx.projects.open(item))
    ctx.projects.touch(directory)
    setSelection({ server: ServerConnection.key(conn), directory })
  }

  function openNewSession() {
    const conn = focusedServer()
    const project = newSessionProject()
    if (!conn || !project) return
    openProjectNewSession(conn, project.worktree)
  }

  function openProjectNewSession(conn: ServerConnection.Any, directory: string) {
    const ctx = global.ensureServerCtx(conn)
    ctx.projects.open(directory)
    ctx.projects.touch(directory)
    void tabs.newDraft({ server: ServerConnection.key(conn), directory })
  }

  function editProject(conn: ServerConnection.Any, project: LocalProject) {
    void import("@/components/dialog-edit-project-v2").then(({ DialogEditProjectV2 }) => {
      void dialog.show(() => <DialogEditProjectV2 server={conn} project={project} />)
    })
  }

  function directories(project: LocalProject) {
    return [project.worktree, ...(project.sandboxes ?? [])]
  }

  function unseenCount(conn: ServerConnection.Any, project: LocalProject) {
    const state = notification.ensureServerState(ServerConnection.key(conn))
    return directories(project).reduce((total, directory) => total + state.project.unseenCount(directory), 0)
  }

  function clearNotifications(conn: ServerConnection.Any, project: LocalProject) {
    const state = notification.ensureServerState(ServerConnection.key(conn))
    directories(project)
      .filter((directory) => state.project.unseenCount(directory) > 0)
      .forEach((directory) => state.project.markViewed(directory))
  }

  function chooseProject(conn: ServerConnection.Any) {
    if (global.servers.health[ServerConnection.key(conn)]?.healthy === false) return
    pickDirectory({
      server: conn,
      title: language.t("command.project.open"),
      multiple: true,
      onSelect: (result) => addProjects(conn, homeProjectDirectories(result)),
    })
  }

  function closeProject(conn: ServerConnection.Any, directory: string) {
    const next = closeHomeProject(
      selection(),
      ServerConnection.key(conn),
      global.ensureServerCtx(conn).projects,
      directory,
    )
    if (next) setSelection(next)
  }

  function moveProject(conn: ServerConnection.Any, worktree: string, index: number) {
    global.ensureServerCtx(conn).projects.move(worktree, index)
  }

  function revealProject(conn: ServerConnection.Any, project: LocalProject) {
    if (!platform.openPath || !canRevealProject(conn)) return
    platform.openPath(project.worktree).catch((cause: unknown) =>
      showToast({
        title: language.t("common.requestFailed"),
        description: errorMessage(cause, language.t("common.requestFailed")),
      }),
    )
  }

  function canRevealProject(conn: ServerConnection.Any) {
    return platform.platform === "desktop" && !!platform.openPath && ServerConnection.local(conn)
  }

  function projectsForServer(conn: ServerConnection.Any) {
    return global.ensureServerCtx(conn).projects.list()
  }

  function collapsed(conn: ServerConnection.Any) {
    return state().collapsed[ServerConnection.key(conn)] ?? false
  }

  function serverMenuID(conn: ServerConnection.Any) {
    return `server:${ServerConnection.key(conn)}`
  }

  function projectMenuID(conn: ServerConnection.Any, directory: string) {
    return `project:${ServerConnection.key(conn)}:${directory}`
  }

  return {
    language,
    selection,
    focusedServer,
    focusedServerCtx,
    focusedSync,
    projects,
    recentlyClosed,
    homedir,
    selectedProject,
    newSessionProject,
    servers: global.servers.list,
    serverHealth: (conn: ServerConnection.Any) => global.servers.health[ServerConnection.key(conn)],
    projectsForServer,
    collapsed,
    toggleCollapsed: (conn: ServerConnection.Any) => {
      const key = ServerConnection.key(conn)
      setState("collapsed", key, !state().collapsed[key])
    },
    menuOpen: (id: string) => menu.open === id,
    setMenuOpen: (id: string, open: boolean) => setMenu("open", open ? id : undefined),
    serverMenuID,
    projectMenuID,
    canDefaultServer: serverManagement.canDefault,
    isDefaultServer: (conn: ServerConnection.Any) => serverManagement.defaultKey() === ServerConnection.key(conn),
    setDefaultServer: (conn: ServerConnection.Any | undefined) =>
      serverManagement.setDefault(conn ? ServerConnection.key(conn) : null),
    removeServer: (conn: ServerConnection.Any) => serverManagement.handleRemove(ServerConnection.key(conn)),
    openEditServer: (conn: ServerConnection.Http) => dialog.show(() => <DialogServerV2 mode="edit" server={conn} />),
    focusServer,
    selectProject,
    addProjects,
    openNewSession,
    openProjectNewSession,
    editProject,
    unseenCount,
    clearNotifications,
    chooseProject,
    closeProject,
    moveProject,
    canRevealProject,
    revealProject,
    fileManagerActionLabel: () =>
      language.t(fileManagerApp(platform.platform === "desktop" ? (platform.os ?? "unknown") : "unknown").actionLabel),
    openSettings,
    openHelp: () => platform.openLink("https://opencode.ai/desktop-feedback"),
  }
}

export type HomeProjectsController = ReturnType<typeof createHomeProjectsController>
