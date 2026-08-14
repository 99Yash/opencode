import { createMemo, createResource, createSignal } from "solid-js"
import type { SessionInfo } from "@opencode-ai/client"
import path from "path"
import { useTerminalDimensions } from "@opentui/solid"
import type { RGBA } from "@opentui/core"
import { dialogWidth, useDialog } from "../ui/dialog"
import { DialogSelect, dialogSelectContentWidth } from "../ui/dialog-select"
import { useRoute } from "../context/route"
import { useData } from "../context/data"
import { useClient } from "../context/client"
import { useLocation } from "../context/location"
import { useSessionTabs } from "../context/session-tabs"
import { useTheme, useThemes } from "../context/theme"
import { Keymap } from "../context/keymap"
import { Locale } from "../util/locale"
import { abbreviateHome } from "../runtime"
import { useTuiPaths } from "../context/runtime"
import { truncateFilePath } from "../ui/file-path"
import { stringWidth } from "../util/string-width"
import { withTimestampedFallback } from "@opencode-ai/util/session-title-fallback"
import { Spinner } from "./spinner"
import { projectName } from "../util/project"
import { DialogMoveSession } from "./dialog-move-session"
import { DialogPrompt } from "../ui/dialog-prompt"
import { useToast } from "../ui/toast"
import { errorMessage } from "../util/error"

const RECENT_LIMIT = 3
export const DialogOpenKey = Symbol("DialogOpen")

type OpenTarget =
  | { type: "session"; sessionID: string }
  | { type: "location"; directory: string; projectID?: string; vcs?: "git" | "hg" }

export async function loadDialogOpen(data: ReturnType<typeof useData>, client: ReturnType<typeof useClient>) {
  const [, sessions] = await Promise.all([
    data.project.sync().catch(() => {}),
    client.api.session
      .list({ limit: 50, order: "desc", parentID: null })
      .then((response) => response.data)
      .catch(() => [] as SessionInfo[]),
  ])
  return sessions
}

export function DialogOpen(props: { sessions: SessionInfo[] }) {
  const dialog = useDialog()
  const route = useRoute()
  const data = useData()
  const client = useClient()
  const location = useLocation()
  const sessionTabs = useSessionTabs()
  const themes = useThemes()
  const theme = useTheme("elevated")
  const mode = themes.mode
  const paths = useTuiPaths()
  const dimensions = useTerminalDimensions()
  const shortcuts = Keymap.useShortcuts()
  const toast = useToast()
  const [filter, setFilter] = createSignal("")
  const [selectionMoved, setSelectionMoved] = createSignal(false)
  const [selected, setSelected] = createSignal<OpenTarget>()

  const [matched] = createResource(
    () => {
      const value = filter().trim()
      return /^ses_[0-9A-Za-z]{26}$/.test(value) ? value : undefined
    },
    (sessionID) =>
      client.api.session
        .get({ sessionID })
        .then((session) => (session.id === sessionID ? session : undefined))
        .catch(() => undefined),
  )

  const openTabs = createMemo(
    () => new Set(sessionTabs.enabled() ? sessionTabs.tabs().map((tab) => tab.sessionID) : []),
  )
  const currentSessionID = createMemo(() =>
    route.data.type === "session" ? data.session.root(route.data.sessionID) : undefined,
  )
  const sessions = createMemo(() => {
    const seen = new Set<string>()
    const match = matched()
    return [...data.session.list(), ...props.sessions, ...(match ? [match] : [])]
      .filter((session) => {
        if (session.parentID || seen.has(session.id)) return false
        seen.add(session.id)
        return true
      })
      .toSorted((a, b) => b.time.updated - a.time.updated)
  })

  const options = createMemo(() => {
    const tabs = openTabs()
    const exact = matched()
    const recent = sessions()
      .filter((session) => !tabs.has(session.id))
      .slice(0, RECENT_LIMIT)
      .concat(exact && !tabs.has(exact.id) ? [exact] : [])
      .filter((session, index, items) => items.findIndex((item) => item.id === session.id) === index)
    const sessionOptions = recent.map((session) => {
      const project = data.project.get(session.projectID)
      const name = projectName(project)
      const running =
        data.session.status(session.id) === "running" ||
        data.session.family(session.id).some((id) => data.session.status(id) === "running")
      return {
        title: withTimestampedFallback(session),
        searchText: session.id,
        value: { type: "session", sessionID: session.id } as OpenTarget,
        category: "Recent sessions",
        footer: `${name ? `${Locale.truncate(name, 20)} · ` : ""}${timeAgo(session.time.updated)}`,
        onSelect: () => location.set(session.location),
        gutter: running
          ? (color: RGBA) => <Spinner color={color} />
          : tabs.has(session.id)
            ? () => <text fg={theme.hue.accent[mode() === "light" ? 800 : 200]}>▪</text>
            : undefined,
      }
    })

    const current = location.current
    const locations = new Map<
      string,
      { directory: string; title: string; updated: number; projectID?: string; vcs?: "git" | "hg" }
    >()
    for (const project of data.project.list()) {
      if (project.canonical === "/" || isDisposableLocation(project.canonical) || locations.has(project.canonical))
        continue
      locations.set(project.canonical, {
        directory: project.canonical,
        title: projectName(project) ?? project.canonical,
        updated: project.time.updated,
        projectID: project.id,
        vcs: project.vcs,
      })
    }
    for (const session of sessions()) {
      const project = data.project.get(session.projectID)
      const directory = project && project.canonical !== "/" ? project.canonical : session.location.directory
      if (isDisposableLocation(directory)) continue
      const existing = locations.get(directory)
      if (existing) {
        existing.updated = Math.max(existing.updated, session.time.updated)
        continue
      }
      locations.set(directory, {
        directory,
        title: projectName(project) ?? (path.basename(directory) || directory),
        updated: session.time.updated,
        projectID: project?.canonical === "/" ? undefined : project?.id,
        vcs: project?.vcs,
      })
    }
    const locationOptions = [...locations.values()]
      .toSorted((a, b) => b.updated - a.updated)
      .map((item) => {
        const footer = abbreviateHome(item.directory, paths.home)
        const width =
          dialogSelectContentWidth(Math.min(dialogWidth("large"), dimensions().width - 2)) - stringWidth(item.title)
        return {
          title: item.title,
          footer: truncateFilePath(footer, width),
          searchText: footer,
          value: {
            type: "location",
            directory: item.directory,
            projectID: item.projectID,
            vcs: item.vcs,
          } as OpenTarget,
          category: "Recent locations",
          gutter:
            item.directory === current?.directory || item.directory === current?.project.canonical
              ? () => <text fg={theme.text.formfield.selected}>●</text>
              : undefined,
        }
      })

    return [...sessionOptions, ...locationOptions]
  })

  function openLocation(directory: string) {
    dialog.clear()
    const target = { directory }
    route.navigate({ type: "home", location: target })
    location.set(target)
  }

  function openWorktrees(target: OpenTarget | undefined) {
    if (target?.type !== "location" || !target.projectID || target.vcs !== "git") return
    const projectID = target.projectID
    dialog.replace(() => (
      <DialogMoveSession
        projectID={projectID}
        title="Open worktree"
        randomWorktree={true}
        onSelect={(selection) => {
          if (selection.type === "directory") {
            openLocation(selection.directory)
            return
          }
          void client.api.worktree
            .create({
              projectID,
              strategy: "git",
              directory: path.join(paths.worktree, projectID.slice(0, 6)),
              name: selection.name,
            })
            .then((result) => openLocation(result.directory))
            .catch((error) =>
              toast.show({ variant: "error", title: "Creating worktree failed", message: errorMessage(error) }),
            )
        }}
      />
    ))
  }

  function browse() {
    dialog.replace(() => (
      <DialogPrompt
        title="Open folder"
        placeholder="Absolute path"
        value={location.current?.directory ?? paths.home}
        onConfirm={(value) => {
          const directory = value.trim().replace(/^~(?=$|[\\/])/, paths.home)
          if (!directory) return
          void client.api.file
            .list({ location: { directory } })
            .then(() => openLocation(directory))
            .catch((error) =>
              toast.show({ variant: "error", title: "Could not open folder", message: errorMessage(error) }),
            )
        }}
      />
    ))
  }

  return (
    <DialogSelect
      title="Open"
      placeholder="Search sessions and locations…"
      options={options()}
      current={currentSessionID() ? ({ type: "session", sessionID: currentSessionID()! } as OpenTarget) : undefined}
      focusCurrent={false}
      sectionNavigation={true}
      preserveSelection={selectionMoved()}
      onMove={(option) => {
        setSelectionMoved(true)
        setSelected(option.value)
      }}
      onFilter={setFilter}
      footer={
        <text fg={theme.text.default}>
          enter <span style={{ fg: theme.text.subdued }}>open</span>
          {"   "}→/tab <span style={{ fg: theme.text.subdued }}>worktrees</span>
          {"   "}/ <span style={{ fg: theme.text.subdued }}>browse</span>
        </text>
      }
      bindings={[
        {
          bind: "right,tab",
          title: "Open worktrees",
          group: "Dialog",
          run: () => openWorktrees(selected() ?? options()[0]?.value),
        },
        { bind: "/", title: "Browse folders", group: "Dialog", run: browse },
      ]}
      noMatchView={
        <box paddingLeft={4} paddingRight={4}>
          <text fg={theme.text.subdued}>
            {shortcuts.get("session.list")
              ? `No matches · search all sessions with ${shortcuts.get("session.list")}`
              : "No matches"}
          </text>
        </box>
      }
      onSelect={(option) => {
        dialog.clear()
        if (option.value.type === "session") {
          route.navigate({ type: "session", sessionID: option.value.sessionID })
          return
        }
        openLocation(option.value.directory)
      }}
    />
  )
}

function timeAgo(timestamp: number) {
  const minutes = Math.floor((Date.now() - timestamp) / 60_000)
  if (minutes < 1) return "now"
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo`
  return `${Math.floor(days / 365)}y`
}

function isDisposableLocation(directory: string) {
  return /^opencode-(?:test|e2e-project)-/.test(path.basename(directory))
}
