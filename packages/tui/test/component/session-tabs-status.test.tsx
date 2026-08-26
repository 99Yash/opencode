/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { createSignal } from "solid-js"
import { ConfigProvider, useConfig } from "../../src/config"
import { EMPTY_SESSION_TAB_STATUS, SessionTabs, type SessionTabsController } from "../../src/component/session-tabs"
import { SPINNER_FRAMES } from "../../src/component/spinner"
import { ClientProvider } from "../../src/context/client"
import { DataProvider } from "../../src/context/data"
import { ThemeProvider } from "../../src/context/theme"
import { emptyThemeSource } from "../fixture/fixture"
import { createApi, createEventStream, createFetch } from "../fixture/tui-client"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"

for (const orientation of ["horizontal", "vertical"] as const) {
  for (const width of [48, 120]) {
    for (const mode of ["light", "dark"] as const) {
      test(`${orientation} tab status icons toggle and update at ${width} columns in ${mode} mode`, async () => {
        const [finished, setFinished] = createSignal(false)
        const [read, setRead] = createSignal(false)
        const [blocked, setBlocked] = createSignal(true)
        const controller = {
          tabs: () => [
            { sessionID: "idle", title: "Idle" },
            { sessionID: "busy", title: "Busy" },
            { sessionID: "done", title: "Done" },
            { sessionID: "wait", title: "Wait" },
          ],
          current: () => "idle",
          select() {},
          close() {},
          move() {},
          detail: () => "project",
          status(sessionID) {
            return {
              ...EMPTY_SESSION_TAB_STATUS,
              busy: sessionID === "wait" || (sessionID === "busy" && !finished()),
              attention: sessionID === "wait" && blocked(),
              unread: !read() && (sessionID === "done" || sessionID === "busy") ? "activity" : undefined,
            }
          },
        } satisfies SessionTabsController
        let config!: ReturnType<typeof useConfig>
        let configuration = { animations: false, experimental: { "tab-status-icons": false } }
        function Tabs() {
          config = useConfig()
          return <SessionTabs controller={controller} orientation={orientation} width={Math.min(width, 32)} />
        }
        const app = await testRender(
          () => (
            <TestTuiContexts>
              <ConfigProvider
                config={createTuiResolvedConfig(configuration)}
                service={{
                  get: async () => configuration,
                  update: async (update) => {
                    configuration = structuredClone(configuration)
                    update(configuration)
                    return configuration
                  },
                }}
              >
                <ClientProvider api={createApi(createFetch(undefined, createEventStream()).fetch)}>
                  <DataProvider>
                    <ThemeProvider mode={mode} source={emptyThemeSource}>
                      <Tabs />
                    </ThemeProvider>
                  </DataProvider>
                </ClientProvider>
              </ConfigProvider>
            </TestTuiContexts>
          ),
          { width, height: 16 },
        )
        try {
          app.renderer.start()
          await app.waitForFrame((frame) => frame.includes("4 Wait"))
          expect(app.captureCharFrame()).toContain("1 Idle")
          expect(app.captureCharFrame()).toContain("2 Busy")
          expect(app.captureCharFrame()).toContain("3 Done")

          await config.update((draft) => {
            draft.experimental["tab-status-icons"] = true
          })
          await app.waitForFrame((frame) => frame.includes("⋯ Busy"))
          expect(app.captureCharFrame()).toContain("• Done")
          expect(app.captureCharFrame()).toContain("1 Idle")
          expect(app.captureCharFrame()).toContain("4 Wait")
          expect(app.captureCharFrame()).not.toMatch(/[●⚠]/)

          await config.update((draft) => {
            draft.animations = true
          })
          await app.waitForFrame((frame) => SPINNER_FRAMES.some((glyph) => frame.includes(`${glyph} Busy`)))
          expect(app.captureCharFrame()).toContain("4 Wait")

          setBlocked(false)
          await app.waitForFrame((frame) => SPINNER_FRAMES.some((glyph) => frame.includes(`${glyph} Wait`)))
          setFinished(true)
          await app.waitForFrame((frame) => frame.includes("• Busy"))
          setRead(true)
          await app.waitForFrame((frame) => frame.includes("3 Done"))
          expect(app.captureCharFrame()).toContain("2 Busy")
          expect(app.captureCharFrame()).not.toMatch(/[•●⚠]/)

          setRead(false)
          await app.waitForFrame((frame) => frame.includes("• Done"))

          await config.update((draft) => {
            draft.experimental["tab-status-icons"] = false
          })
          await app.waitForFrame((frame) => frame.includes("4 Wait"))
          expect(app.captureCharFrame()).toContain("2 Busy")
          expect(app.captureCharFrame()).toContain("3 Done")
          expect(app.captureCharFrame()).not.toContain("•")
        } finally {
          app.renderer.destroy()
        }
      })
    }
  }
}
