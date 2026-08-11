import { expect, test } from "bun:test"
import { sessionContentWidth, sessionTabsFitVertically, SESSION_SIDEBAR_WIDTH } from "../../src/ui/layout"

test("vertical tabs match the session sidebar and preserve compact content width", () => {
  expect(SESSION_SIDEBAR_WIDTH).toBe(42)
  expect(sessionTabsFitVertically(86)).toBe(true)
  expect(sessionTabsFitVertically(85)).toBe(false)
})

test("session content uses available width by default", () => {
  expect(sessionContentWidth(160, false)).toBe(156)
  expect(sessionContentWidth(160, true)).toBe(114)
})

test("session content caps wide sessions and preserves narrow sessions", () => {
  expect(sessionContentWidth(160, false, 100)).toBe(96)
  expect(sessionContentWidth(80, false, 100)).toBe(76)
})
