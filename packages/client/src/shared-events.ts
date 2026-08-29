export * as SharedEvents from "./shared-events.js"

export class SubscriberOverflowError extends Error {
  constructor() {
    super("Event subscriber queue overflow")
    this.name = "SubscriberOverflowError"
  }
}

export function make<A extends { readonly type: string }>(
  connect: (signal: AbortSignal) => AsyncIterable<A>,
  options?: { readonly capacity?: number },
) {
  type Completion = { readonly error: unknown } | Record<string, never>
  type Subscriber = {
    push: (value: A) => void
    finish: (completion: Completion) => void
  }
  type Connection = {
    controller: AbortController
    subscribers: Set<Subscriber>
    connected?: A
    read?: ReturnType<typeof Promise.withResolvers<IteratorResult<A>>>
    done: ReturnType<typeof Promise.withResolvers<void>>
  }

  const capacity = options?.capacity ?? 4096
  let current: Connection | undefined

  function stop(connection: Connection) {
    connection.connected = undefined
    connection.read?.resolve({ done: true, value: undefined })
    connection.controller.abort()
  }

  async function run(connection: Connection) {
    let iterator: AsyncIterator<A> | undefined
    let completion: Completion = {}
    try {
      if (connection.controller.signal.aborted) return
      iterator = connect(connection.controller.signal)[Symbol.asyncIterator]()
      while (!connection.controller.signal.aborted) {
        // Cancellation must reach return() even when the source has a pending next().
        connection.read = Promise.withResolvers<IteratorResult<A>>()
        Promise.resolve(iterator.next()).then(connection.read.resolve, connection.read.reject)
        const item = await connection.read.promise
        connection.read = undefined
        if (item.done || connection.controller.signal.aborted) break
        if (item.value.type === "server.connected") connection.connected = { ...item.value }
        connection.subscribers.forEach((subscriber) => subscriber.push(item.value))
      }
    } catch (error) {
      completion = { error }
    } finally {
      stop(connection)
      try {
        await iterator?.return?.()
      } catch (error) {
        if (!("error" in completion)) completion = { error }
      }
      connection.subscribers.forEach((subscriber) => subscriber.finish(completion))
      current = undefined
      connection.done.resolve()
    }
  }

  return {
    subscribe(options?: { readonly signal?: AbortSignal }): AsyncIterable<A> {
      return {
        [Symbol.asyncIterator]() {
          const queue: A[] = []
          const pending: ReturnType<typeof Promise.withResolvers<IteratorResult<A>>>[] = []
          let started = false
          let completion: Completion | undefined
          let connection: Connection | undefined

          function finish(result: Completion, discard = false) {
            completion = result
            if (discard || "error" in result) queue.length = 0
            options?.signal?.removeEventListener("abort", abort)
            if (connection?.subscribers.delete(subscriber) && !connection.subscribers.size) stop(connection)
            pending.splice(0).forEach((request) => {
              if ("error" in result) request.reject(result.error)
              else request.resolve({ done: true, value: undefined })
            })
          }

          function abort() {
            finish({}, true)
          }

          const subscriber: Subscriber = {
            finish,
            push(value) {
              const event = value.type === "server.connected" ? { ...value } : value
              const request = pending.shift()
              if (request) {
                request.resolve({ done: false, value: event })
                return
              }
              if (queue.length >= capacity) {
                finish({ error: new SubscriberOverflowError() })
                return
              }
              queue.push(event)
            },
          }

          async function start() {
            // A replacement connection cannot overlap the previous iterator's cleanup.
            while (current?.controller.signal.aborted) await current.done.promise
            if (completion) return
            const fresh = !current
            connection = current ?? {
              controller: new AbortController(),
              subscribers: new Set<Subscriber>(),
              done: Promise.withResolvers<void>(),
            }
            current = connection
            connection.subscribers.add(subscriber)
            if (connection.connected) subscriber.push(connection.connected)
            if (fresh) void run(connection)
          }

          return {
            next(): Promise<IteratorResult<A>> {
              const value = queue.shift()
              if (value !== undefined) return Promise.resolve({ done: false, value })
              if (completion) {
                if ("error" in completion) return Promise.reject(completion.error)
                return Promise.resolve({ done: true, value: undefined })
              }
              if (options?.signal?.aborted) {
                abort()
                return Promise.resolve({ done: true, value: undefined })
              }
              const request = Promise.withResolvers<IteratorResult<A>>()
              pending.push(request)
              if (!started) {
                started = true
                options?.signal?.addEventListener("abort", abort, { once: true })
                void start()
              }
              return request.promise
            },
            return(): Promise<IteratorResult<A>> {
              finish({}, true)
              return Promise.resolve({ done: true, value: undefined })
            },
          }
        },
      }
    },
  }
}
