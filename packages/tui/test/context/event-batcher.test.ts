import { describe, expect, test } from "bun:test"
import { createEventBatcher } from "../../src/context/event-batcher"

function clock() {
  let time = 100
  const scheduled = new Map<ReturnType<typeof setTimeout>, { callback: () => void; at: number }>()
  return {
    now: () => time,
    schedule(callback: () => void, delay: number) {
      const timer = setTimeout(() => {}, 60_000)
      scheduled.set(timer, { callback, at: time + delay })
      return timer
    },
    cancel(timer: ReturnType<typeof setTimeout>) {
      clearTimeout(timer)
      scheduled.delete(timer)
    },
    advance(delay: number) {
      time += delay
      for (const [timer, task] of scheduled) {
        if (task.at > time) continue
        clearTimeout(timer)
        scheduled.delete(timer)
        task.callback()
      }
    },
    pending() {
      return scheduled.size
    },
  }
}

describe("createEventBatcher", () => {
  test("preserves events in frame-bounded flushes", () => {
    const time = clock()
    const flushes: number[][] = []
    const batcher = createEventBatcher<number>((events) => flushes.push(events), time)

    batcher.add(1)
    time.advance(1)
    batcher.add(2)
    batcher.add(3)

    expect(flushes).toEqual([[1]])
    expect(time.pending()).toBe(1)
    time.advance(15)
    expect(flushes).toEqual([[1]])
    time.advance(1)
    expect(flushes).toEqual([[1], [2, 3]])
    expect(flushes.flat()).toEqual([1, 2, 3])
  })

  test("flushes a live generation and discards an obsolete generation", () => {
    const time = clock()
    const live: number[][] = []
    const active = createEventBatcher<number>((events) => live.push(events), time)
    active.add(1)
    time.advance(1)
    active.add(2)
    active.end(false)

    const obsolete: number[][] = []
    const stale = createEventBatcher<number>((events) => obsolete.push(events), time)
    stale.add(3)
    time.advance(1)
    stale.add(4)
    stale.end(true)
    time.advance(16)

    expect(live).toEqual([[1], [2]])
    expect(obsolete).toEqual([[3]])
    expect(time.pending()).toBe(0)
  })

  test("caps a batch when timers cannot run", () => {
    const time = clock()
    const flushes: number[][] = []
    const batcher = createEventBatcher<number>((events) => flushes.push(events), { ...time, limit: 3 })

    batcher.add(1)
    time.advance(1)
    batcher.add(2)
    batcher.add(3)
    batcher.add(4)

    expect(flushes).toEqual([[1], [2, 3, 4]])
    expect(time.pending()).toBe(0)
  })
})
