import { createComponent, createEffect, createMemo, type Accessor, type Component, type JSX } from "solid-js"
import type { SelectedLineRange } from "@/context/file"
import { SESSION_OPEN_FILE_TAB, createOpenSessionFileTab, createSessionTabs } from "@/pages/session/helpers"

type TreeMode = "changes" | "all"

type Input = {
  currentTab: Accessor<string | undefined>
  allTabs: Accessor<string[]>
  openTab: (tab: string) => void
  preview: (tab: string) => void
  setActive: (tab: string) => void
  normalizeFileTab: (tab: string) => string
  pathFromTab: (tab: string) => string | undefined
  loadFile: (path: string) => void
  reviewEnabled: Accessor<boolean>
  canReview: Accessor<boolean>
  fileBrowserEnabled: Accessor<boolean>
  reviewPanelOpened: Accessor<boolean>
  openReviewPanel: () => void
  treeMode: Accessor<TreeMode>
  setTreeMode: (mode: TreeMode) => void
  fileReady: Accessor<boolean>
  sessionKey: Accessor<string>
  selectedLines: (path: string) => unknown
  persistHandoff: (key: string, files: Record<string, SelectedLineRange | null>) => void
  showDialog: (render: () => JSX.Element) => void
  loadSelectFileDialog?: () => Promise<{
    DialogSelectFile: Component<{ mode?: "files"; onOpenFile?: (path: string) => void }>
  }>
}

export function createSessionSidePanelController(input: Input) {
  const normalizeTab = (tab: string) => (tab.startsWith("file://") ? input.normalizeFileTab(tab) : tab)
  const openReviewPanel = () => {
    if (!input.reviewPanelOpened()) input.openReviewPanel()
  }
  const tabs = createSessionTabs({
    tabs: () => ({ active: input.currentTab, all: input.allTabs }),
    pathFromTab: input.pathFromTab,
    normalizeTab,
    review: input.reviewEnabled,
    hasReview: input.canReview,
    fileBrowser: input.fileBrowserEnabled,
  })
  const prepareTab = (tab: string) => {
    const path = input.pathFromTab(tab)
    if (path) input.loadFile(path)
    openReviewPanel()
    return tab
  }
  const open = createOpenSessionFileTab({
    normalizeTab,
    openTab: input.openTab,
    pathFromTab: input.pathFromTab,
    loadFile: input.loadFile,
    openReviewPanel,
    setActive: input.setActive,
  })
  const preview = (value: string) => {
    const next = normalizeTab(value)
    input.preview(next)
    const selected = prepareTab(next)
    queueMicrotask(() => input.setActive(selected))
  }
  const activate = (value: string) => input.setActive(prepareTab(normalizeTab(value)))
  const openFileBrowser = () => preview(SESSION_OPEN_FILE_TAB)
  const browserTab = createMemo(() => {
    if (!input.fileBrowserEnabled()) return undefined
    const active = tabs.activeTab()
    if (active === SESSION_OPEN_FILE_TAB) return SESSION_OPEN_FILE_TAB
    if (active && input.pathFromTab(active)) return active
    return tabs.activeFileTab()
  })
  // Keep the shell mounted while any file tab exists. Kobalte briefly selects
  // Review while replacing a preview trigger, which must not reset sidebar scroll.
  const fileBrowserMounted = createMemo(
    () =>
      input.fileBrowserEnabled() && (tabs.openedTabs().length > 0 || tabs.openFileOpen() || browserTab() !== undefined),
  )
  const fileBrowserVisible = createMemo(() => {
    const active = tabs.activeTab()
    return active !== "review" && active !== "context" && active !== "empty"
  })
  const setTreeMode = (value: string) => {
    if (value !== "changes" && value !== "all") return
    input.setTreeMode(value)
  }
  const showAllFiles = () => {
    if (input.treeMode() !== "changes") return
    input.setTreeMode("all")
  }
  const openFileDialog = async () => {
    const load = input.loadSelectFileDialog ?? (() => import("@/components/dialog-select-file"))
    const { DialogSelectFile } = await load()
    input.showDialog(() => createComponent(DialogSelectFile, { mode: "files", onOpenFile: showAllFiles }))
  }

  createEffect(() => {
    if (!input.fileReady()) return
    input.persistHandoff(
      input.sessionKey(),
      sessionSidePanelHandoffFiles(input.allTabs(), input.pathFromTab, input.selectedLines),
    )
  })

  return {
    tabs: {
      ...tabs,
      normalize: normalizeTab,
      open,
      preview,
      activate,
    },
    browser: {
      tab: browserTab,
      mounted: fileBrowserMounted,
      visible: fileBrowserVisible,
      open: openFileBrowser,
    },
    tree: {
      mode: input.treeMode,
      setMode: setTreeMode,
      showAll: showAllFiles,
    },
    dialog: {
      openFile: openFileDialog,
    },
  }
}

export function sessionSidePanelHandoffFiles(
  tabs: readonly string[],
  pathFromTab: (tab: string) => string | undefined,
  selectedLines: (path: string) => unknown,
) {
  return tabs.reduce<Record<string, SelectedLineRange | null>>((files, tab) => {
    const path = pathFromTab(tab)
    if (!path) return files
    const selected = selectedLines(path)
    files[path] = isSelectedLineRange(selected) ? selected : null
    return files
  }, {})
}

function isSelectedLineRange(value: unknown): value is SelectedLineRange {
  return !!value && typeof value === "object" && "start" in value && "end" in value
}

export type SessionSidePanelController = ReturnType<typeof createSessionSidePanelController>
