import { describe, expect, test } from "bun:test"
import { scheduleTextReveal, springOpacity, transcriptionPulse } from "../src/animation"

describe("voice text animation", () => {
  test("stages newly streamed words without delaying them indefinitely", () => {
    const first = scheduleTextReveal("", "Hello there", 1_000, 0)
    expect(first.reveals).toEqual([
      { offset: 0, at: 1_000 },
      { offset: 6, at: 1_032 },
    ])
    expect(first.animationEndsAt).toBe(1_352)

    const queued = scheduleTextReveal("Hello there", " friend", 1_010, 10_000)
    expect(queued.reveals).toEqual([{ offset: 12, at: 1_170 }])
  })

  test("fades text monotonically to fully visible", () => {
    expect(springOpacity(100, 100)).toBe(0)
    expect(springOpacity(260, 100)).toBeGreaterThan(0)
    expect(springOpacity(260, 100)).toBeLessThan(1)
    expect(springOpacity(420, 100)).toBe(1)
  })

  test("keeps transcription pulse bounded and moving", () => {
    const levels = [0, 110, 220, 330].map(transcriptionPulse)
    expect(levels.every((level) => level >= 0 && level <= 1)).toBe(true)
    expect(new Set(levels).size).toBeGreaterThan(1)
  })
})
