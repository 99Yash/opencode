import { expect, test } from "bun:test"
import type { TerminalColors } from "@opentui/core"
import { generateSystemV2 } from "../../src/theme/system"
import { resolveThemeFile } from "../../src/theme/v2/resolve"

const colors: TerminalColors = {
  palette: ["#15161e", "#f7768e", "#9ece6a", "#e0af68", "#7aa2f7", "#bb9af7", "#7dcfff", "#a9b1d6"],
  defaultForeground: "#c0caf5",
  defaultBackground: "#1a1b26",
  cursorColor: null,
  mouseForeground: null,
  mouseBackground: null,
  tekForeground: null,
  tekBackground: null,
  highlightBackground: null,
  highlightForeground: null,
}

test("generates literal V2 hue scales from the system palette", () => {
  const resolved = resolveThemeFile(generateSystemV2(colors), "dark")

  for (const step of [100, 300, 500, 700, 900] as const) {
    expect(resolved.hue.red[step].toInts()).toEqual([247, 118, 142, 255])
    expect(resolved.hue.orange[step].toInts()).toEqual([224, 175, 104, 255])
    expect(resolved.hue.yellow[step].toInts()).toEqual([224, 175, 104, 255])
    expect(resolved.hue.green[step].toInts()).toEqual([158, 206, 106, 255])
    expect(resolved.hue.cyan[step].toInts()).toEqual([125, 207, 255, 255])
    expect(resolved.hue.blue[step].toInts()).toEqual([122, 162, 247, 255])
    expect(resolved.hue.purple[step].toInts()).toEqual([187, 154, 247, 255])
    expect(resolved.hue.accent[step].toInts()).toEqual([125, 207, 255, 255])
    expect(resolved.hue.interactive[step].toInts()).toEqual([125, 207, 255, 255])
  }

  expect(resolved.text.default.toInts()).toEqual([192, 202, 245, 255])
  expect(resolved.background.default.toInts()).toEqual([26, 27, 38, 0])
  expect(resolved.background.action.primary.default.toInts()).toEqual([125, 207, 255, 255])
})
