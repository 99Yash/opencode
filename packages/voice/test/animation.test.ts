import { describe, expect, test } from "bun:test"
import {
  connectionMeterLevels,
  connectionTransitioning,
  scheduleTextReveal,
  textRevealOpacity,
  transcriptionPulse,
} from "../src/animation"

describe("voice text animation", () => {
  test("stages newly streamed words without delaying them indefinitely", () => {
    const first = scheduleTextReveal("", "Hello there", 1_000, 0)
    expect(first.reveals).toEqual([
      { offset: 0, at: 1_000 },
      { offset: 6, at: 1_032 },
    ])
    expect(first.animationEndsAt).toBe(1_412)

    const queued = scheduleTextReveal("Hello there", " friend", 1_010, 10_000)
    expect(queued.reveals).toEqual([{ offset: 12, at: 1_170 }])
  })

  test("slowly fades text into its stable color", () => {
    const opacities = [100, 195, 290, 385, 480].map((now) => textRevealOpacity(now, 100))
    expect(opacities[0]).toBe(0.16)
    expect(opacities.toSorted((a, b) => a - b)).toEqual(opacities)
    expect(opacities.at(-1)).toBe(1)
  })

  test("keeps transcription pulse bounded and moving", () => {
    const levels = [0, 110, 220, 330].map(transcriptionPulse)
    expect(levels.every((level) => level >= 0 && level <= 1)).toBe(true)
    expect(new Set(levels).size).toBeGreaterThan(1)
  })

  test("moves the connecting pulse left to right and blends into the connected meter", () => {
    const first = connectionMeterLevels(1_000, 0.1, undefined, 1_000)
    const next = connectionMeterLevels(1_180, 0.1, undefined, 1_000)
    expect(first.indexOf(Math.max(...first))).toBe(0)
    expect(first.indexOf(Math.max(...first))).toBeLessThan(next.indexOf(Math.max(...next)))

    const samples = Array.from({ length: 16 }, (_, index) => connectionMeterLevels(index * 45, 0.1))
    expect(samples.every((levels) => Math.max(...levels) > 0.85)).toBe(true)

    const handoff = connectionMeterLevels(1_000, 0.4, 1_000)
    expect(handoff).toEqual(connectionMeterLevels(1_000, 0.4))
    expect(connectionMeterLevels(1_480, 0.4, 1_000)).toEqual(
      [0, 1, 2, 3].map((index) => 0.4 * (0.72 + Math.sin(1_480 / 240 + index * 1.4) * 0.28)),
    )
    expect(connectionTransitioning(1_479, 1_000)).toBe(true)
    expect(connectionTransitioning(1_480, 1_000)).toBe(false)
  })
})
