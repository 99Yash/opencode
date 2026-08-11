import { expect, test } from "bun:test"
import {
  sessionLaneLayout,
  sessionTabsFitVertically,
  SESSION_SIDEBAR_WIDTH,
  SESSION_TECHNICAL_LANE_WIDTH,
} from "../../src/ui/layout"

test("vertical tabs match the session sidebar and preserve compact content width", () => {
  expect(SESSION_SIDEBAR_WIDTH).toBe(42)
  expect(sessionTabsFitVertically(86)).toBe(true)
  expect(sessionTabsFitVertically(85)).toBe(false)
})

test("session lanes center the prose measure on one leading edge", () => {
  expect(SESSION_TECHNICAL_LANE_WIDTH).toBe(88)
  // Wide canvas: prose is truly centered, technical extends rightward.
  expect(sessionLaneLayout(156, 66)).toEqual({ inset: 45, readable: 66, technical: 88 })
  // Centering the prose would push the technical rail past the canvas; clamp.
  expect(sessionLaneLayout(100, 66)).toEqual({ inset: 12, readable: 66, technical: 88 })
  expect(sessionLaneLayout(80, 66)).toEqual({ inset: 0, readable: 66, technical: 80 })
  expect(sessionLaneLayout(60, 66)).toEqual({ inset: 0, readable: 60, technical: 60 })
})
