/** @jsxImportSource @opentui/solid */
import { BoxRenderable, RGBA, TextRenderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { onCleanup } from "solid-js"
import { ConfigProvider } from "../../../src/config"
import { Keymap } from "../../../src/context/keymap"
import { ThemeProvider, useTheme } from "../../../src/context/theme"
import { DialogProvider } from "../../../src/ui/dialog"
import { DialogExportOptions } from "../../../src/ui/dialog-export-options"
import { ToastProvider } from "../../../src/ui/toast"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"

test("uses focused action colors for Copy while preserving its inactive overlay colors", async () => {
  let focusedBackground = RGBA.fromInts(0, 0, 0, 0)
  let focusedText = RGBA.fromInts(0, 0, 0, 0)
  let inactiveBackground = RGBA.fromInts(0, 0, 0, 0)
  let inactiveText = RGBA.fromInts(0, 0, 0, 0)

  function ExportOptions() {
    const elevated = useTheme("elevated")
    const overlay = useTheme("overlay")
    focusedBackground = elevated.background.action.primary.focused
    focusedText = elevated.text.action.primary.focused
    inactiveBackground = overlay.background.default
    inactiveText = overlay.text.default
    onCleanup(Keymap.use().mode.push("modal"))
    return <DialogExportOptions defaultThinking={true} />
  }

  const app = await testRender(
    () => (
      <ConfigProvider config={createTuiResolvedConfig()}>
        <Keymap.Provider>
          <ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}>
            <ToastProvider>
              <DialogProvider>
                <ExportOptions />
              </DialogProvider>
            </ToastProvider>
          </ThemeProvider>
        </Keymap.Provider>
      </ConfigProvider>
    ),
    { width: 80, height: 20, kittyKeyboard: true },
  )

  try {
    app.renderer.start()
    await app.waitForFrame((frame) => frame.includes("Export session"))
    const content = app.renderer.root.getChildren()[0] as BoxRenderable
    const actions = content.getChildren().at(-1) as BoxRenderable
    const copy = actions.getChildren()[0] as BoxRenderable
    const label = copy.getChildren()[0] as TextRenderable

    expect(copy.backgroundColor.toInts()).toEqual(inactiveBackground.toInts())
    expect(label.fg.toInts()).toEqual(inactiveText.toInts())

    app.mockInput.pressTab()
    app.mockInput.pressTab()
    app.mockInput.pressTab()
    await app.renderOnce()

    expect(copy.backgroundColor.toInts()).toEqual(focusedBackground.toInts())
    expect(label.fg.toInts()).toEqual(focusedText.toInts())
  } finally {
    app.renderer.destroy()
  }
})
