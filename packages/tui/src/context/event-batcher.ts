const defaultInterval = 16
const defaultLimit = 1_024

type Options = {
  interval?: number
  limit?: number
  now?: () => number
  schedule?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>
  cancel?: (timer: ReturnType<typeof setTimeout>) => void
}

export function createEventBatcher<T>(onFlush: (events: T[]) => void, options: Options = {}) {
  const interval = options.interval ?? defaultInterval
  const limit = options.limit ?? defaultLimit
  const now = options.now ?? Date.now
  const schedule = options.schedule ?? setTimeout
  const cancel = options.cancel ?? clearTimeout
  let queue: T[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  let last = 0
  let ended = false

  function flush() {
    if (queue.length === 0) return
    const pending = queue
    queue = []
    timer = undefined
    last = now()
    onFlush(pending)
  }

  return {
    add(event: T) {
      if (ended) return
      queue.push(event)
      if (queue.length >= limit) {
        if (timer !== undefined) cancel(timer)
        flush()
        return
      }
      if (timer !== undefined) return
      if (now() - last >= interval) {
        flush()
        return
      }
      timer = schedule(flush, interval)
    },
    end(discard: boolean) {
      if (ended) return
      ended = true
      if (timer !== undefined) cancel(timer)
      timer = undefined
      if (!discard) flush()
      queue = []
    },
  }
}
