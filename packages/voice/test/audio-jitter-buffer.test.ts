import { describe, expect, test } from "bun:test"
import { AudioJitterBuffer } from "../src/audio-jitter-buffer"
import { PCM_BYTES_PER_MS } from "../src/pcm"

const chunk = (durationMs: number, gapMs = 0) => ({ bytes: Buffer.alloc(durationMs * PCM_BYTES_PER_MS), gapMs })

describe("AudioJitterBuffer", () => {
  test("holds startup audio until the target buffer is available", () => {
    const buffer = new AudioJitterBuffer(300)
    expect(buffer.push(chunk(100))).toEqual([])
    expect(buffer.push(chunk(100))).toEqual([])
    expect(buffer.push(chunk(100))).toHaveLength(3)
  })

  test("passes chunks through after playback starts", () => {
    const buffer = new AudioJitterBuffer(200)
    buffer.push(chunk(200))
    expect(buffer.push(chunk(100))).toEqual([chunk(100)])
  })

  test("flushes short utterances and resets between responses", () => {
    const buffer = new AudioJitterBuffer(300)
    buffer.push(chunk(100))
    expect(buffer.finish()).toHaveLength(1)
    buffer.reset()
    expect(buffer.push(chunk(100))).toEqual([])
  })

  test("counts intentional timeline silence toward buffered duration", () => {
    const buffer = new AudioJitterBuffer(300)
    expect(buffer.push(chunk(200, 100))).toHaveLength(1)
  })
})
