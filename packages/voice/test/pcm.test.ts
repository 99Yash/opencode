import { expect, test } from "bun:test"
import { pcmLevel } from "../src/pcm"

test("PCM level ignores silence and normalizes audible energy", () => {
  expect(pcmLevel(Buffer.alloc(4_800))).toBe(0)
  const audible = Buffer.alloc(4_800)
  for (let offset = 0; offset < audible.length; offset += 2) audible.writeInt16LE(8_000, offset)
  expect(pcmLevel(audible)).toBeGreaterThan(0.8)
  expect(pcmLevel(audible)).toBeLessThanOrEqual(1)
})
