import { PCM_BYTES_PER_MS } from "./pcm"

export type PlaybackChunk = {
  readonly bytes: Buffer
  readonly gapMs: number
}

export class AudioJitterBuffer {
  private readonly pending: PlaybackChunk[] = []
  private durationMs = 0
  private started = false

  constructor(private readonly targetMs = 500) {}

  push(chunk: PlaybackChunk): ReadonlyArray<PlaybackChunk> {
    if (this.started) return [chunk]
    this.pending.push(chunk)
    this.durationMs += chunk.gapMs + chunk.bytes.length / PCM_BYTES_PER_MS
    if (this.durationMs < this.targetMs) return []
    this.started = true
    return this.drain()
  }

  finish(): ReadonlyArray<PlaybackChunk> {
    if (this.pending.length === 0) return []
    this.started = true
    return this.drain()
  }

  reset() {
    this.pending.length = 0
    this.durationMs = 0
    this.started = false
  }

  private drain() {
    const chunks = this.pending.splice(0)
    this.durationMs = 0
    return chunks
  }
}
