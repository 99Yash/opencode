import type { Session } from "@opencode-ai/sdk/v2/client"
import { preloadMarkdown } from "@opencode-ai/session-ui/markdown-cache"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useMarked } from "@opencode-ai/ui/context/marked"
import { makeEventListener } from "@solid-primitives/event-listener"
import { useQuery } from "@tanstack/solid-query"
import { DateTime } from "luxon"
import {
  type Accessor,
  createEffect,
  createMemo,
  createRoot,
  createSignal,
  type JSX,
  on,
  onCleanup,
  startTransition,
} from "solid-js"
import { createStore, produce } from "solid-js/store"
import { useCommand } from "@/context/command"
import {
  loadHomeSessionIndex,
  retainHomeSessions,
  type HomeSessionEvents,
} from "@/context/global-sync/home-session-index"
import type { LocalProject } from "@/context/layout"
import { useLanguage } from "@/context/language"
import { ServerConnection, serverName } from "@/context/server"
import { sessionHasOpenTab, useTabs } from "@/context/tabs"
import { displayName, errorMessage, projectForSession } from "@/pages/layout/helpers"
import { useSessionTabAvatarState } from "@/pages/layout/project-avatar-state"
import { pathKey } from "@/utils/path-key"
import { showToast } from "@/utils/toast"
import { Binary } from "@opencode-ai/core/util/binary"
import { archiveHomeSession } from "../home-session-archive"
import type { HomeProjectsController } from "./home-projects-controller"

const HOME_SESSION_LIMIT = 64
const HOME_SESSION_HEADER_STICKY_TOP = 12
const HOME_SESSION_HEADER_TEXT_HEIGHT = 16
const HOME_SESSION_HEADER_FADE_DISTANCE = 16

export type HomeSessionRecord = {
  session: Session
  project: LocalProject
  projectName: string
}

export type HomeSessionGroup = {
  id: "today" | "yesterday" | "older"
  title: string
  sessions: HomeSessionRecord[]
}

export type OpenSessionOptions = { background?: boolean }

export function createHomeSessionsController(projects: HomeProjectsController) {
  const tabs = useTabs()
  const command = useCommand()
  const dialog = useDialog()
  const language = useLanguage()
  const marked = useMarked()
  const [state, setState] = createStore({ search: "", searchFocused: false, active: "" })
  const [thumbTrack, setThumbTrack] = createSignal<HTMLDivElement>()
  const [hoverTarget, setHoverTarget] = createSignal<HTMLElement>()
  let viewport: HTMLDivElement | undefined
  let searchRoot: HTMLDivElement | undefined
  let searchInput: HTMLInputElement | undefined
  let searchList: HTMLDivElement | undefined
  const search = createMemo(() => state.search.trim())
  const projectDirectories = createMemo(() => {
    const project = projects.selectedProject()
    if (!project) return projects.projects().flatMap(directories)
    return directories(project)
  })
  const projectByID = createMemo(
    () => new Map(projects.projects().flatMap((project) => (project.id ? [[project.id, project] as const] : []))),
  )
  const homeSessions = () => projects.focusedSync().homeSessions
  const sessionEventLoad = useQuery(() => ({
    queryKey: homeSessions().eventsKey,
    queryFn: async (): Promise<HomeSessionEvents> => ({ sequence: 0, entries: [] }),
    initialData: { sequence: 0, entries: [] } satisfies HomeSessionEvents,
    enabled: false,
  }))
  const sessionLoad = useQuery(() => ({
    queryKey: homeSessions().indexKey,
    enabled: !!projects.focusedServerCtx(),
    queryFn: async ({ signal }) => {
      const ctx = projects.focusedServerCtx()
      if (!ctx) return { sessions: [], eventSequence: 0 }
      const cache = homeSessions()
      const eventSequence = cache.eventSequence()
      const index = await loadHomeSessionIndex(
        (input, options) => ctx.sdk.client.v2.session.list(input, options),
        eventSequence,
        signal,
      )
      cache.complete(eventSequence)
      return index
    },
    retry: false,
    staleTime: 30_000,
    refetchOnMount: true,
    refetchOnReconnect: true,
  }))
  const indexedSessions = createMemo(() =>
    retainHomeSessions(
      homeSessions().sessions(sessionLoad.data, sessionEventLoad.data),
      HOME_SESSION_LIMIT,
      Date.now(),
    ),
  )
  const allRecords = createMemo(() =>
    buildHomeSessionRecords({
      sessions: indexedSessions,
      projectDirectories,
      projects: projects.projects,
      projectByID,
    }),
  )
  const records = createMemo(() => allRecords().slice(0, HOME_SESSION_LIMIT))
  const searchResults = createMemo(() => {
    const query = search().toLowerCase()
    if (!query) return []
    return allRecords().filter((record) => matchesHomeSessionSearch(record, query))
  })
  const searchOpen = createMemo(() => state.searchFocused && search().length > 0)
  const searchPlaceholder = createMemo(() => {
    const project = projects.selectedProject()
    if (project) return language.t("home.sessions.search.placeholder.scoped", { scope: displayName(project) })
    if (projects.servers().length > 1) {
      const conn = projects.focusedServer()
      if (conn) return language.t("home.sessions.search.placeholder.scoped", { scope: serverName(conn) })
    }
    return language.t("home.sessions.search.placeholder")
  })
  const groups = createMemo(() => groupSessions(records(), language))
  const header = createHomeSessionHeaderController(groups)
  const prefetched = new Set<string>()

  createEffect(() => {
    const ctx = projects.focusedServerCtx()
    const conn = projects.focusedServer()
    if (!ctx || !conn) return
    records()
      .slice(0, 2)
      .forEach((record) => {
        const key = `${ServerConnection.key(conn)}\0${record.session.id}`
        if (prefetched.has(key)) return
        prefetched.add(key)
        createRoot((dispose) => {
          try {
            void ctx.sync.session
              .sync(record.session.id)
              .then(() =>
                Promise.all(
                  (ctx.sync.session.data.message[record.session.id] ?? []).flatMap((message) =>
                    (ctx.sync.session.data.part[message.id] ?? []).flatMap((part) => {
                      if (part.type !== "text" || !part.text) return []
                      return preloadMarkdown(part.text, part.id, marked)
                    }),
                  ),
                ),
              )
              .catch(() => {})
              .finally(dispose)
          } catch {
            dispose()
          }
        })
      })
  })

  createEffect(() => syncActive(searchResults()))
  createEffect(
    on(
      () => state.search,
      () => syncActive(searchResults()),
    ),
  )
  onCleanup(
    makeEventListener(document, "pointerdown", (event) => {
      if (!searchOpen()) return
      const target = event.target
      if (!(target instanceof Node) || searchRoot?.contains(target)) return
      closeSearch()
    }),
  )

  command.register("home", () => [
    {
      id: "command.palette",
      title: language.t("command.palette"),
      hidden: true,
      onSelect: async () => {
        const conn = projects.focusedServer()
        if (!conn) return
        const ctx = projects.focusedServerCtx()
        if (!ctx) return
        const { DialogHomeCommandPaletteV2 } = await import("@/components/dialog-command-palette-v2")
        void dialog.show(() => (
          <DialogHomeCommandPaletteV2
            server={conn}
            onSelectSession={(entry) => {
              if (!entry.sessionID || !entry.directory || !entry.server) return
              const sessionID = entry.sessionID
              const server = entry.server
              const directory = entry.project?.worktree ?? entry.directory
              ctx.projects.open(directory)
              ctx.projects.touch(directory)
              void startTransition(() => {
                const tab = tabs.addSessionTab({ server, sessionId: sessionID })
                tabs.select(tab)
              })
            }}
          />
        ))
      },
    },
    {
      id: "home.sessions.search.focus",
      title: searchPlaceholder(),
      keybind: "mod+f",
      hidden: true,
      onSelect: focusSearch,
    },
  ])

  function syncActive(results: HomeSessionRecord[]) {
    if (results.length === 0) {
      setState("active", "")
      return
    }
    if (!results.some((record) => homeSessionSearchKey(record) === state.active)) {
      setState("active", homeSessionSearchKey(results[0]))
    }
  }

  function focusSearch() {
    searchInput?.focus()
    setState("searchFocused", true)
  }

  function closeSearch() {
    setState("search", "")
    setState("searchFocused", false)
  }

  function moveActive(delta: number) {
    const results = searchResults()
    if (results.length === 0) return
    const index = results.findIndex((record) => homeSessionSearchKey(record) === state.active)
    const next = ((index === -1 ? 0 : index) + delta + results.length) % results.length
    setState("active", homeSessionSearchKey(results[next]))
    searchList?.querySelector<HTMLElement>(`[data-key="${state.active}"]`)?.scrollIntoView({ block: "nearest" })
  }

  function selectSearchSession(record: HomeSessionRecord, options?: OpenSessionOptions) {
    openSession(record.session, options)
    if (!options?.background) closeSearch()
  }

  function openSession(session: Session, options?: OpenSessionOptions) {
    const directoryKey = pathKey(session.directory)
    const project =
      projects
        .projects()
        .find(
          (item) =>
            pathKey(item.worktree) === directoryKey ||
            item.sandboxes?.some((sandbox) => pathKey(sandbox) === directoryKey),
        ) ?? projectForSession(session, projects.projects(), projectByID())
    const conn = projects.focusedServer()
    if (!conn) return
    const directory = project?.worktree ?? session.directory
    const ctx = projects.focusedServerCtx()
    if (!ctx) return
    ctx.projects.open(directory)
    if (options?.background) {
      tabs.addSessionTab({ server: ServerConnection.key(conn), sessionId: session.id })
      return
    }
    ctx.projects.touch(directory)
    void startTransition(() => {
      const tab = tabs.addSessionTab({ server: ServerConnection.key(conn), sessionId: session.id })
      tabs.select(tab)
    })
  }

  async function archiveSession(session: Session) {
    const conn = projects.focusedServer()
    const ctx = projects.focusedServerCtx()
    if (!conn || !ctx) return
    const [, setStore] = ctx.sync.child(session.directory)
    await archiveHomeSession({
      server: ServerConnection.key(conn),
      session,
      update: (value) => ctx.sdk.client.session.update(value),
      remove: () =>
        setStore(
          produce((draft) => {
            const match = Binary.search(draft.session, session.id, (item) => item.id)
            if (match.found) draft.session.splice(match.index, 1)
          }),
        ),
      onError: (cause) =>
        showToast({
          title: language.t("common.requestFailed"),
          description: errorMessage(cause, language.t("common.requestFailed")),
        }),
    })
  }

  function setViewport(element: HTMLDivElement) {
    viewport = element
    header.setViewport(element)
  }

  function containWheel(event: WheelEvent) {
    if (!viewport) return
    if (event.defaultPrevented || event.ctrlKey || !event.deltaY) return
    if (!(event.target instanceof Element)) return
    const scrollable = event.target.closest<HTMLElement>("[data-scrollable]")
    if (
      scrollable !== viewport &&
      scrollable &&
      (event.deltaY < 0
        ? scrollable.scrollTop > 0
        : scrollable.scrollTop < scrollable.scrollHeight - scrollable.clientHeight)
    )
      return
    event.preventDefault()
  }

  return {
    language,
    records,
    groups,
    loading: () => sessionLoad.isLoading,
    showProjectName: () => !projects.selectedProject(),
    server: () => projects.selection().server,
    canCreateSession: () => !!projects.newSessionProject(),
    createSession: projects.openNewSession,
    openSession,
    archiveSession,
    hasOpenTab: (record: HomeSessionRecord) =>
      sessionHasOpenTab(tabs.store, projects.selection().server, record.session),
    header,
    scroll: {
      thumbTrack,
      hoverTarget,
      setThumbTrack,
      setHoverTarget,
      setViewport,
      update: (scrollTop: number) => header.update(scrollTop),
      containWheel,
      containOuterWheel: (event: WheelEvent) => {
        if (!viewport) return
        if (event.target instanceof Node && viewport.contains(event.target)) return
        containWheel(event)
      },
    },
    search: {
      value: () => state.search,
      query: search,
      placeholder: searchPlaceholder,
      open: searchOpen,
      loading: () => sessionLoad.isLoading,
      results: searchResults,
      active: () => state.active,
      noResultsLabel: () => language.t("home.sessions.search.noResults", { query: search() }),
      setRoot: (element: HTMLDivElement) => (searchRoot = element),
      setInput: (element: HTMLInputElement) => (searchInput = element),
      setList: (element: HTMLDivElement) => (searchList = element),
      input: (value: string) => setState("search", value),
      focus: focusSearch,
      close: closeSearch,
      highlight: (record: HomeSessionRecord) => setState("active", homeSessionSearchKey(record)),
      move: moveActive,
      select: selectSearchSession,
      selectActive: () => {
        const record = searchResults().find((item) => homeSessionSearchKey(item) === state.active)
        if (record) selectSearchSession(record)
      },
    },
  }
}

function directories(project: LocalProject) {
  return [project.worktree, ...(project.sandboxes ?? [])]
}

function buildHomeSessionRecords(input: {
  sessions: () => Session[]
  projectDirectories: () => string[]
  projects: () => LocalProject[]
  projectByID: () => Map<string, LocalProject>
}) {
  const directories = new Set(input.projectDirectories().map(pathKey))
  const sessions = input.sessions().filter((session) => directories.has(pathKey(session.directory)))
  return [...new Map(sessions.map((session) => [session.id, session] as const)).values()]
    .sort((a, b) => (b.time.updated ?? b.time.created) - (a.time.updated ?? a.time.created))
    .flatMap((session) => {
      const directory = pathKey(session.directory)
      const project =
        input
          .projects()
          .find(
            (item) =>
              pathKey(item.worktree) === directory || item.sandboxes?.some((sandbox) => pathKey(sandbox) === directory),
          ) ?? projectForSession(session, input.projects(), input.projectByID())
      if (!project) return []
      return { session, project, projectName: displayName(project) }
    })
}

function matchesHomeSessionSearch(record: HomeSessionRecord, query: string) {
  return `${record.session.title} ${record.projectName}`.toLowerCase().includes(query)
}

export function homeSessionSearchKey(record: HomeSessionRecord) {
  return `${pathKey(record.session.directory)}:${record.session.id}`
}

function groupSessions(records: HomeSessionRecord[], language: ReturnType<typeof useLanguage>): HomeSessionGroup[] {
  const now = DateTime.local()
  const yesterday = now.minus({ days: 1 })
  const todaySessions = records.filter((record) =>
    DateTime.fromMillis(record.session.time.updated ?? record.session.time.created).hasSame(now, "day"),
  )
  const yesterdaySessions = records.filter((record) =>
    DateTime.fromMillis(record.session.time.updated ?? record.session.time.created).hasSame(yesterday, "day"),
  )
  const olderSessions = records.filter((record) => {
    const time = DateTime.fromMillis(record.session.time.updated ?? record.session.time.created)
    return !time.hasSame(now, "day") && !time.hasSame(yesterday, "day")
  })
  const olderTitle =
    todaySessions.length === 0 && yesterdaySessions.length === 0
      ? language.t("sidebar.project.recentSessions")
      : language.t("home.sessions.group.older")
  return [
    { id: "today" as const, title: language.t("home.sessions.group.today"), sessions: todaySessions },
    { id: "yesterday" as const, title: language.t("home.sessions.group.yesterday"), sessions: yesterdaySessions },
    { id: "older" as const, title: olderTitle, sessions: olderSessions },
  ].filter((group) => group.sessions.length > 0)
}

function createHomeSessionHeaderController(groups: () => HomeSessionGroup[]) {
  let viewport: HTMLDivElement | undefined
  let content: HTMLDivElement | undefined
  let positionFrame: number | undefined
  let resizeObserver: ResizeObserver | undefined
  let stickyTop = HOME_SESSION_HEADER_STICKY_TOP
  const headerRefs = new Map<HomeSessionGroup["id"], HTMLDivElement>()
  const headerOffsets = new Map<HomeSessionGroup["id"], number>()
  const [state, setState] = createStore({
    titleOpacity: {} as Partial<Record<HomeSessionGroup["id"], number>>,
  })

  createEffect(() => {
    const items = groups()
    const ids = new Set(items.map((group) => group.id))
    headerRefs.forEach((_, id) => {
      if (!ids.has(id)) headerRefs.delete(id)
    })
    headerOffsets.forEach((_, id) => {
      if (!ids.has(id)) headerOffsets.delete(id)
    })
    if (items.length === 0) {
      content = undefined
      bindResizeObserver()
    }
    queuePositionUpdate()
  })

  onCleanup(() => {
    if (positionFrame !== undefined) cancelAnimationFrame(positionFrame)
    resizeObserver?.disconnect()
  })

  function setViewport(element: HTMLDivElement) {
    viewport = element
    bindResizeObserver()
    queuePositionUpdate()
  }

  function setContent(element: HTMLDivElement) {
    content = element
    bindResizeObserver()
    queuePositionUpdate()
  }

  function setHeader(id: HomeSessionGroup["id"], element: HTMLDivElement) {
    headerRefs.set(id, element)
    queuePositionUpdate()
  }

  function queuePositionUpdate() {
    if (typeof requestAnimationFrame === "undefined") {
      updatePositionCache()
      return
    }
    if (positionFrame !== undefined) return
    positionFrame = requestAnimationFrame(() => {
      positionFrame = undefined
      updatePositionCache()
    })
  }

  function updatePositionCache() {
    if (!viewport) return
    const header = groups()
      .map((group) => headerRefs.get(group.id))
      .find((element) => element !== undefined)
    if (header && typeof getComputedStyle === "function") {
      const top = Number.parseFloat(getComputedStyle(header).top)
      if (Number.isFinite(top)) stickyTop = top
    }
    groups().forEach((group) => {
      const element = headerRefs.get(group.id)
      if (element) headerOffsets.set(group.id, element.offsetTop)
    })
    update(viewport.scrollTop)
  }

  function update(scrollTop: number) {
    const items = groups()
    items.forEach((group, index) => {
      const nextOffset = items
        .slice(index + 1)
        .map((item) => headerOffsets.get(item.id))
        .find((offset) => offset !== undefined)
      const fadeEnd = stickyTop + HOME_SESSION_HEADER_TEXT_HEIGHT
      const nextTop = nextOffset === undefined ? undefined : nextOffset - scrollTop
      const opacity =
        nextTop === undefined ? 1 : Math.max(0, Math.min(1, (nextTop - fadeEnd) / HOME_SESSION_HEADER_FADE_DISTANCE))
      setState("titleOpacity", group.id, Math.round(opacity * 1000) / 1000)
    })
  }

  function bindResizeObserver() {
    resizeObserver?.disconnect()
    if (typeof ResizeObserver === "undefined") return
    resizeObserver = new ResizeObserver(queuePositionUpdate)
    if (viewport) resizeObserver.observe(viewport)
    if (content) resizeObserver.observe(content)
  }

  return {
    setViewport,
    setContent,
    setHeader,
    update,
    titleOpacity: (id: HomeSessionGroup["id"]) => state.titleOpacity[id] ?? 1,
  }
}

export type HomeSessionsController = ReturnType<typeof createHomeSessionsController>

export function HomeSessionStatusController(props: {
  server: Accessor<ServerConnection.Key>
  record: HomeSessionRecord
  isOpenTab: (record: HomeSessionRecord) => boolean
  render: (state: { unread: Accessor<boolean>; loading: Accessor<boolean>; open: Accessor<boolean> }) => JSX.Element
}) {
  const avatar = useSessionTabAvatarState(
    props.server,
    () => props.record.session.directory,
    () => props.record.session.id,
  )
  return props.render({
    unread: avatar.unread,
    loading: avatar.loading,
    open: () => props.isOpenTab(props.record),
  })
}
