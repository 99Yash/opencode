import { expect, test } from "bun:test"
import { generateSyntax, resolveThemeDocument } from "@opencode-ai/theme/tui"
import { SyntaxStyle } from "@opentui/core"
import { parseTheme } from "../../../src/theme"

test("generates syntax for a single categorical hue", () => {
  const theme = resolveThemeDocument(parseTheme({ version: 2, light: { categorical: ["red"] } }), "light")
  const syntax = generateSyntax(theme, "light")

  expect(syntax).toBeInstanceOf(SyntaxStyle)
  syntax.destroy()
})
