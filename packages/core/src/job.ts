export * as Job from "./job.js"

import { Cause, Clock, Context, Deferred, Effect, Exit, Layer, Scope, SynchronizedRef } from "effect"
import { makeGlobalNode } from "@opencode-ai/util/effect/app-node"
import { Identifier } from "./id/id.js"
import { SessionSchema } from "./session/schema.js"

export type Status = "running" | "completed" | "error" | "cancelled"

export type Info = {
  id: string
  type: string
  title?: string
  status: Status
  started_at: number
  completed_at?: number
  output?: string
  error?: string
  metadata?: Record<string, unknown>
}

export type SettledInfo = Info & {
  status: Exclude<Status, "running">
  completed_at: number
}

type Active = {
  info: Info
  done: Deferred.Deferred<Info>
  backgrounded: Deferred.Deferred<Info>
  onBackgroundSettled?: (info: SettledInfo) => Effect.Effect<void>
  backgroundNotification?: Deferred.Deferred<void>
  scope: Scope.Closeable
  token: object
  blockingSessions: Map<SessionSchema.ID, number>
  isBackgrounded: boolean
}

type State = {
  jobs: SynchronizedRef.SynchronizedRef<Map<string, Active>>
  notifications: Set<Deferred.Deferred<void>>
  scope: Scope.Scope
  shuttingDown: boolean
}

type Notification = {
  jobID: string
  effect: Effect.Effect<void>
  done: Deferred.Deferred<void>
}

type FinishResult = {
  info?: Info
  done?: Deferred.Deferred<Info>
  notify?: Notification
  scope?: Scope.Closeable
}

type BackgroundResult = {
  info?: Info
  backgrounded?: Deferred.Deferred<Info>
  notify?: Notification
  cancel?: { id: string; token: object }
}

type StartResult = { info: Info } | { info: Info; scope: Scope.Closeable; token: object }

type BlockWait = {
  done: Deferred.Deferred<Info>
  backgrounded: Deferred.Deferred<Info>
}

type BlockStart =
  | { type: "missing" }
  | { type: "finished"; info: Info }
  | { type: "backgrounded"; info: Info }
  | { type: "wait"; wait: BlockWait }

export type StartInput = {
  id?: string
  type: string
  title?: string
  metadata?: Record<string, unknown>
  run: Effect.Effect<string, unknown>
  onBackgroundSettled?: (info: SettledInfo) => Effect.Effect<void>
}

export type WaitInput = {
  id: string
  timeout?: number
}

export type WaitResult = {
  info?: Info
  timedOut: boolean
}

export type BlockInput = {
  id: string
  sessionID: SessionSchema.ID
}

export type BlockResult = { type: "finished"; info: Info } | { type: "backgrounded"; info: Info }

export type BackgroundAllInput = {
  sessionID: SessionSchema.ID
  type?: string
}

export interface Interface {
  readonly get: (id: string) => Effect.Effect<Info | undefined>
  readonly start: (input: StartInput) => Effect.Effect<Info>
  readonly wait: (input: WaitInput) => Effect.Effect<WaitResult>
  readonly block: (input: BlockInput) => Effect.Effect<BlockResult | undefined>
  readonly background: (id: string) => Effect.Effect<Info | undefined>
  readonly backgroundAll: (input: BackgroundAllInput) => Effect.Effect<Info[]>
  readonly cancel: (id: string) => Effect.Effect<Info | undefined>
  /** Cancels detached work and awaits its terminal callbacks before application teardown. */
  readonly shutdown: Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Job") {}

function snapshot(job: Active): Info {
  return {
    ...job.info,
    ...(job.info.metadata ? { metadata: { ...job.info.metadata } } : {}),
  }
}

function errorText(error: unknown) {
  if (error instanceof Error) return error.message
  return String(error)
}

function incrementSession(input: Map<SessionSchema.ID, number>, sessionID: SessionSchema.ID) {
  return new Map(input).set(sessionID, (input.get(sessionID) ?? 0) + 1)
}

function decrementSession(input: Map<SessionSchema.ID, number>, sessionID: SessionSchema.ID) {
  const count = input.get(sessionID)
  if (count === undefined) return input
  const next = new Map(input)
  if (count <= 1) next.delete(sessionID)
  else next.set(sessionID, count - 1)
  return next
}

function clearNotification(job: Active) {
  if (!job.onBackgroundSettled && !job.backgroundNotification) return job
  return { ...job, onBackgroundSettled: undefined, backgroundNotification: undefined }
}

function claimNotification(job: Active, info: SettledInfo) {
  if (!job.isBackgrounded || !job.onBackgroundSettled || !job.backgroundNotification) return { job }
  return {
    job: clearNotification(job),
    notify: {
      jobID: info.id,
      effect: job.onBackgroundSettled(info),
      done: job.backgroundNotification,
    },
  }
}

/**
 * Makes one scoped, process-local registry. Entries are intentionally not
 * durable: process restart or owner-scope closure loses status and interrupts
 * live work. Persisted observation, restart recovery, and remote workers need a
 * separate durable ownership slice rather than pretending this registry has
 * those semantics.
 */
export const make = Effect.gen(function* () {
  const state: State = {
    jobs: yield* SynchronizedRef.make(new Map()),
    notifications: new Set(),
    scope: yield* Scope.Scope,
    shuttingDown: false,
  }

  const notify = Effect.fnUntraced(function* (notification: Notification) {
    yield* notification.effect.pipe(
      Effect.catchCause((cause) =>
        Effect.logError("Failed to notify background Job settlement", { jobID: notification.jobID, cause }),
      ),
      Effect.ensuring(
        Effect.sync(() => state.notifications.delete(notification.done)).pipe(
          Effect.andThen(Deferred.succeed(notification.done, undefined)),
        ),
      ),
    )
  })

  const launchNotification = Effect.fnUntraced(function* (notification: Notification) {
    yield* notify(notification).pipe(Effect.forkIn(state.scope, { startImmediately: true }))
  })

  const settle = Effect.fnUntraced(function* (id: string, token: object, exit: Exit.Exit<string, unknown>) {
    const completed_at = yield* Clock.currentTimeMillis
    const result = yield* SynchronizedRef.modify(state.jobs, (jobs): readonly [FinishResult, Map<string, Active>] => {
      const job = jobs.get(id)
      if (!job) return [{}, jobs]
      if (job.token !== token) return [{}, jobs]
      if (job.info.status !== "running") return [{ info: snapshot(job) }, jobs]
      const status: Exclude<Status, "running"> = Exit.isSuccess(exit)
        ? "completed"
        : Cause.hasInterruptsOnly(exit.cause)
          ? "cancelled"
          : "error"
      const info = {
        ...job.info,
        status,
        completed_at,
        ...(Exit.isSuccess(exit) ? { output: exit.value } : {}),
        ...(Exit.isFailure(exit) ? { error: errorText(Cause.squash(exit.cause)) } : {}),
        ...(job.info.metadata ? { metadata: { ...job.info.metadata } } : {}),
      } satisfies SettledInfo
      const next = {
        ...job,
        blockingSessions: new Map<SessionSchema.ID, number>(),
        info,
      }
      const notification = claimNotification(next, info)
      return [
        {
          info,
          done: job.done,
          notify: notification.notify,
          scope: job.scope,
        },
        new Map(jobs).set(id, notification.job),
      ]
    })
    if (result.info && result.done) yield* Deferred.succeed(result.done, result.info).pipe(Effect.ignore)
    if (result.notify) yield* launchNotification(result.notify)
    if (result.scope) {
      yield* Scope.close(result.scope, Exit.void).pipe(
        Effect.catchCause((cause) => Effect.logError("Failed to close settled Job scope", { id, cause })),
        Effect.forkIn(state.scope, { startImmediately: true }),
      )
    }
    return result.info
  })

  const fork = Effect.fnUntraced(function* (
    scope: Scope.Scope,
    id: string,
    token: object,
    run: Effect.Effect<string, unknown>,
  ) {
    return yield* run.pipe(
      Effect.matchCauseEffect({
        onSuccess: (output) => settle(id, token, Exit.succeed(output)),
        onFailure: (cause) => settle(id, token, Exit.failCause(cause)),
      }),
      Effect.asVoid,
      Effect.forkIn(scope, { startImmediately: true }),
    )
  })

  const get: Interface["get"] = Effect.fn("Job.get")(function* (id) {
    const job = (yield* SynchronizedRef.get(state.jobs)).get(id)
    if (!job) return undefined
    return snapshot(job)
  })

  const start: Interface["start"] = Effect.fnUntraced(function* (input) {
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const id = input.id ?? Identifier.ascending("job")
        const started_at = yield* Clock.currentTimeMillis
        const result = yield* SynchronizedRef.modifyEffect(
          state.jobs,
          Effect.fnUntraced(function* (jobs) {
            if (state.shuttingDown)
              return [
                {
                  info: {
                    id,
                    type: input.type,
                    title: input.title,
                    status: "cancelled",
                    started_at,
                    completed_at: started_at,
                    metadata: input.metadata,
                  },
                },
                jobs,
              ] as readonly [StartResult, Map<string, Active>]
            const existing = jobs.get(id)
            if (existing?.info.status === "running") {
              if (existing.onBackgroundSettled || !input.onBackgroundSettled)
                return [{ info: snapshot(existing) }, jobs] as readonly [StartResult, Map<string, Active>]
              const backgroundNotification = yield* Deferred.make<void>()
              const adopted = {
                ...existing,
                onBackgroundSettled: input.onBackgroundSettled,
                backgroundNotification,
              }
              if (adopted.isBackgrounded) state.notifications.add(backgroundNotification)
              return [{ info: snapshot(adopted) }, new Map(jobs).set(id, adopted)] as readonly [
                StartResult,
                Map<string, Active>,
              ]
            }
            const done = yield* Deferred.make<Info>()
            const backgrounded = yield* Deferred.make<Info>()
            const backgroundNotification = input.onBackgroundSettled ? yield* Deferred.make<void>() : undefined
            const scope = yield* Scope.fork(state.scope, "parallel")
            const token = {}
            const job = {
              info: {
                id,
                type: input.type,
                title: input.title,
                status: "running" as const,
                started_at,
                metadata: input.metadata,
              },
              done,
              backgrounded,
              onBackgroundSettled: input.onBackgroundSettled,
              backgroundNotification,
              scope,
              token,
              blockingSessions: new Map<SessionSchema.ID, number>(),
              isBackgrounded: false,
            }
            return [{ info: snapshot(job), scope, token }, new Map(jobs).set(id, job)] as readonly [
              StartResult,
              Map<string, Active>,
            ]
          }),
        )
        if ("scope" in result) yield* fork(result.scope, id, result.token, restore(input.run))
        return result.info
      }),
    )
  })

  const wait: Interface["wait"] = Effect.fn("Job.wait")(function* (input) {
    const job = (yield* SynchronizedRef.get(state.jobs)).get(input.id)
    if (!job) return { timedOut: false }
    if (job.info.status !== "running") return { info: snapshot(job), timedOut: false }
    if (input.timeout === undefined) return { info: yield* Deferred.await(job.done), timedOut: false }
    if (input.timeout <= 0) return { info: snapshot(job), timedOut: true }
    const info = yield* Deferred.await(job.done).pipe(Effect.timeoutOption(input.timeout))
    if (info._tag === "Some") return { info: info.value, timedOut: false }
    return { info: snapshot(job), timedOut: true }
  })

  const removeBlock = Effect.fnUntraced(function* (input: BlockInput) {
    yield* SynchronizedRef.update(state.jobs, (jobs) => {
      const job = jobs.get(input.id)
      if (!job || job.isBackgrounded) return jobs
      if (job.info.status !== "running") {
        if (!job.onBackgroundSettled) return jobs
        return new Map(jobs).set(input.id, clearNotification(job))
      }
      return new Map(jobs).set(input.id, {
        ...job,
        blockingSessions: decrementSession(job.blockingSessions, input.sessionID),
      })
    })
  })

  const block: Interface["block"] = Effect.fnUntraced(function* (input) {
    const result = yield* SynchronizedRef.modify(state.jobs, (jobs): readonly [BlockStart, Map<string, Active>] => {
      const job = jobs.get(input.id)
      if (!job) return [{ type: "missing" }, jobs]
      if (job.info.status !== "running")
        return [
          { type: "finished", info: snapshot(job) },
          job.onBackgroundSettled ? new Map(jobs).set(input.id, clearNotification(job)) : jobs,
        ]
      if (job.isBackgrounded) return [{ type: "backgrounded", info: snapshot(job) }, jobs]
      return [
        { type: "wait", wait: { done: job.done, backgrounded: job.backgrounded } },
        new Map(jobs).set(input.id, {
          ...job,
          blockingSessions: incrementSession(job.blockingSessions, input.sessionID),
        }),
      ]
    })
    if (result.type === "missing") return undefined
    if (result.type === "finished") return { type: "finished", info: result.info }
    if (result.type === "backgrounded") return { type: "backgrounded", info: result.info }
    return yield* Effect.raceFirst(
      Deferred.await(result.wait.done).pipe(Effect.map((info) => ({ type: "finished" as const, info }))),
      Deferred.await(result.wait.backgrounded).pipe(Effect.map((info) => ({ type: "backgrounded" as const, info }))),
    ).pipe(Effect.ensuring(removeBlock(input)))
  })

  const background: Interface["background"] = Effect.fn("Job.background")(function* (id) {
    const result = yield* SynchronizedRef.modify(
      state.jobs,
      (jobs): readonly [BackgroundResult, Map<string, Active>] => {
        const job = jobs.get(id)
        if (!job) return [{}, jobs]
        if (state.shuttingDown) {
          if (job.info.status === "running") return [{ info: snapshot(job), cancel: { id, token: job.token } }, jobs]
          return [
            { info: snapshot(job) },
            job.onBackgroundSettled ? new Map(jobs).set(id, clearNotification(job)) : jobs,
          ]
        }
        if (job.info.status !== "running") {
          if (!job.onBackgroundSettled || !job.backgroundNotification) return [{}, jobs]
          const info = {
            ...snapshot(job),
            status: job.info.status,
            completed_at: job.info.completed_at ?? job.info.started_at,
          } satisfies SettledInfo
          const next = { ...job, info, isBackgrounded: true }
          state.notifications.add(job.backgroundNotification)
          const notification = claimNotification(next, info)
          return [{ info, notify: notification.notify }, new Map(jobs).set(id, notification.job)]
        }
        if (job.isBackgrounded) return [{ info: snapshot(job) }, jobs]
        const next = {
          ...job,
          isBackgrounded: true,
          blockingSessions: new Map<SessionSchema.ID, number>(),
        }
        if (job.backgroundNotification) state.notifications.add(job.backgroundNotification)
        return [{ info: snapshot(next), backgrounded: job.backgrounded }, new Map(jobs).set(id, next)]
      },
    )
    if (result.cancel) return yield* cancelGeneration(result.cancel.id, result.cancel.token)
    if (result.notify) yield* launchNotification(result.notify)
    if (result.info && result.backgrounded)
      yield* Deferred.succeed(result.backgrounded, result.info).pipe(Effect.ignore)
    return result.info
  })

  const backgroundAll: Interface["backgroundAll"] = Effect.fn("Job.backgroundAll")(function* (input) {
    const result = yield* SynchronizedRef.modify(
      state.jobs,
      (jobs): readonly [BackgroundResult[], Map<string, Active>] => {
        if (state.shuttingDown) return [[], jobs]
        const results: BackgroundResult[] = []
        const next = new Map(jobs)
        for (const [id, job] of jobs) {
          if (job.info.status !== "running") continue
          if (job.isBackgrounded) continue
          if (input.type !== undefined && job.info.type !== input.type) continue
          if (!job.blockingSessions.has(input.sessionID)) continue
          const updated = {
            ...job,
            isBackgrounded: true,
            blockingSessions: new Map<SessionSchema.ID, number>(),
          }
          if (job.backgroundNotification) state.notifications.add(job.backgroundNotification)
          results.push({ info: snapshot(updated), backgrounded: job.backgrounded })
          next.set(id, updated)
        }
        return [results, next]
      },
    )
    yield* Effect.forEach(
      result,
      (item) => (item.info && item.backgrounded ? Deferred.succeed(item.backgrounded, item.info) : Effect.void),
      { discard: true },
    )
    return result.flatMap((item) => (item.info ? [item.info] : []))
  })

  const cancelGeneration = Effect.fnUntraced(function* (id: string, token?: object) {
    const completed_at = yield* Clock.currentTimeMillis
    const result = yield* SynchronizedRef.modify(state.jobs, (jobs): readonly [FinishResult, Map<string, Active>] => {
      const job = jobs.get(id)
      if (!job) return [{}, jobs]
      if (token && job.token !== token) return [{}, jobs]
      if (job.info.status !== "running") return [{ info: snapshot(job) }, jobs]
      const info = {
        ...job.info,
        status: "cancelled" as const,
        completed_at,
        ...(job.info.metadata ? { metadata: { ...job.info.metadata } } : {}),
      } satisfies SettledInfo
      const next = {
        ...job,
        blockingSessions: new Map<SessionSchema.ID, number>(),
        info,
      }
      const notification = claimNotification(next, info)
      return [
        {
          info,
          done: job.done,
          notify: notification.notify,
          scope: job.scope,
        },
        new Map(jobs).set(id, notification.notify ? notification.job : clearNotification(notification.job)),
      ]
    })
    if (result.scope)
      yield* Scope.close(result.scope, Exit.void).pipe(
        Effect.catchCause((cause) => Effect.logError("Failed to close cancelled Job scope", { id, cause })),
      )
    if (result.info && result.done) yield* Deferred.succeed(result.done, result.info).pipe(Effect.ignore)
    if (result.notify) yield* launchNotification(result.notify)
    return result.info
  })

  const cancel: Interface["cancel"] = Effect.fn("Job.cancel")((id) => cancelGeneration(id))

  const shutdown: Interface["shutdown"] = Effect.gen(function* () {
    const drain = yield* SynchronizedRef.modify(state.jobs, (jobs) => {
      state.shuttingDown = true
      return [
        {
          running: Array.from(jobs.values()).filter((job) => job.info.status === "running" && job.isBackgrounded),
          notifications: Array.from(state.notifications),
        },
        jobs,
      ] as const
    })
    yield* Effect.forEach(drain.running, (job) => cancelGeneration(job.info.id, job.token), {
      concurrency: "unbounded",
      discard: true,
    })
    yield* Effect.forEach(drain.notifications, Deferred.await, { concurrency: "unbounded", discard: true })
  }).pipe(Effect.withSpan("Job.shutdown"))

  return Service.of({ get, start, wait, block, background, backgroundAll, cancel, shutdown })
})

const layer = Layer.effect(Service, make)

export const node = makeGlobalNode({ service: Service, layer, deps: [] })
