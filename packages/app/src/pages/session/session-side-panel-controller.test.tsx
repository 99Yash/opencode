import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import { SESSION_OPEN_FILE_TAB } from "./helpers"
import { createSessionSidePanelController, sessionSidePanelHandoffFiles } from "./session-side-panel-controller"

function createController(options?: { active?: string; all?: string[]; mode?: "changes" | "all" }) {
  const calls: string[] = []
  const [state, setState] = createStore({
    active: options?.active,
    all: options?.all ?? ["file://src/a.ts"],
    preview: undefined as string | undefined,
    mode: options?.mode ?? ("changes" as "changes" | "all"),
  })
  return createRoot((dispose) => ({
    dispose,
    calls,
    state,
    controller: createSessionSidePanelController({
      currentTab: () => state.active,
      allTabs: () => state.all,
      openTab: (tab) => calls.push(`open:${tab}`),
      preview: (tab) => calls.push(`preview:${tab}`),
      setActive: (tab) => calls.push(`active:${tab}`),
      normalizeFileTab: (tab) => `file://${tab.slice("file://".length).toLowerCase()}`,
      pathFromTab: (tab) => (tab.startsWith("file://") ? tab.slice("file://".length) : undefined),
      loadFile: (path) => calls.push(`load:${path}`),
      reviewEnabled: () => true,
      canReview: () => true,
      fileBrowserEnabled: () => true,
      reviewPanelOpened: () => false,
      openReviewPanel: () => calls.push("panel"),
      treeMode: () => state.mode,
      setTreeMode: (mode) => setState("mode", mode),
      fileReady: () => false,
      sessionKey: () => "session",
      selectedLines: () => null,
      persistHandoff: () => undefined,
      showDialog: () => undefined,
    }),
  }))
}

describe("session side panel controller", () => {
  test("normalizes and centralizes file tab selection mutations", async () => {
    const owned = createController()

    owned.controller.tabs.activate("file://SRC/A.ts")
    expect(owned.calls).toEqual(["load:src/a.ts", "panel", "active:file://src/a.ts"])

    owned.calls.length = 0
    owned.controller.tabs.preview("file://SRC/B.ts")
    expect(owned.calls).toEqual(["preview:file://src/b.ts", "load:src/b.ts", "panel"])
    await Promise.resolve()
    expect(owned.calls).toEqual(["preview:file://src/b.ts", "load:src/b.ts", "panel", "active:file://src/b.ts"])

    owned.calls.length = 0
    owned.controller.tabs.open("file://SRC/C.ts")
    expect(owned.calls).toEqual(["open:file://src/c.ts", "load:src/c.ts", "panel", "active:file://src/c.ts"])
    owned.dispose()
  })

  test("derives browser selection and controls the tree mode", () => {
    const owned = createController({ active: "file://src/a.ts", all: ["file://src/a.ts"] })

    expect(owned.controller.browser.tab()).toBe("file://src/a.ts")
    expect(owned.controller.browser.mounted()).toBe(true)
    expect(owned.controller.browser.visible()).toBe(true)

    owned.controller.tree.setMode("invalid")
    expect(owned.state.mode).toBe("changes")
    owned.controller.tree.showAll()
    expect(owned.state.mode).toBe("all")
    owned.controller.tree.showAll()
    expect(owned.state.mode).toBe("all")

    owned.calls.length = 0
    owned.controller.browser.open()
    expect(owned.calls[0]).toBe(`preview:${SESSION_OPEN_FILE_TAB}`)
    owned.dispose()
  })

  test("opens the file dialog with the tree handoff callback", async () => {
    let render: (() => unknown) | undefined
    let dialogProps: { mode?: "files"; onOpenFile?: (path: string) => void } | undefined
    const owned = createController()
    const controller = createSessionSidePanelController({
      currentTab: () => undefined,
      allTabs: () => [],
      openTab: () => undefined,
      preview: () => undefined,
      setActive: () => undefined,
      normalizeFileTab: (tab) => tab,
      pathFromTab: () => undefined,
      loadFile: () => undefined,
      reviewEnabled: () => true,
      canReview: () => true,
      fileBrowserEnabled: () => true,
      reviewPanelOpened: () => true,
      openReviewPanel: () => undefined,
      treeMode: owned.controller.tree.mode,
      setTreeMode: owned.controller.tree.setMode,
      fileReady: () => false,
      sessionKey: () => "session",
      selectedLines: () => null,
      persistHandoff: () => undefined,
      showDialog: (value) => (render = value),
      loadSelectFileDialog: async () => ({
        DialogSelectFile: (props) => {
          dialogProps = props
          return null
        },
      }),
    })

    await controller.dialog.openFile()
    render?.()
    expect(dialogProps?.mode).toBe("files")
    dialogProps?.onOpenFile?.("src/a.ts")
    expect(owned.state.mode).toBe("all")
    owned.dispose()
  })
})

test("projects only file tabs into handoff persistence", () => {
  expect(
    sessionSidePanelHandoffFiles(
      ["review", "file://src/a.ts", "file://src/b.ts"],
      (tab) => (tab.startsWith("file://") ? tab.slice("file://".length) : undefined),
      (path) => (path.endsWith("a.ts") ? { start: 2, end: 4 } : { startLine: 2, endLine: 4 }),
    ),
  ).toEqual({ "src/a.ts": { start: 2, end: 4 }, "src/b.ts": null })
})
