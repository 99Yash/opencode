import { describe, expect } from "bun:test"
import { Bus } from "@opencode-ai/core/bus"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { EventTable } from "@opencode-ai/core/event/sql"
import { Job } from "@opencode-ai/core/job"
import { KV } from "@opencode-ai/core/kv"
import { LocationServiceMap } from "@opencode-ai/core/location-service-map"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Session } from "@opencode-ai/core/session"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionRestart } from "@opencode-ai/core/session/execution/restart"
import { SessionResolve } from "@opencode-ai/core/session/resolve"
import { SessionInboxTable, SessionMessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SessionStore } from "@opencode-ai/core/session/store"
import { LayerNode } from "@opencode-ai/util/effect/layer-node"
import { Effect, RcMap } from "effect"
import { testEffect } from "./lib/effect"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      Bus.node,
      Job.node,
      KV.node,
      Session.node,
      SessionStore.node,
      SessionExecution.node,
      SessionRestart.node,
      SessionResolve.node,
      LocationServiceMap.node,
    ]),
  ),
)

describe("capability-owned Session recovery", () => {
  for (const claimed of [false, true]) {
    it.effect(`leaves an owned Session ${claimed ? "with an exhausted claim" : "without a claim"} inert`, () =>
      Effect.gen(function* () {
        const database = yield* Database.Service
        const resolve = yield* SessionResolve.Service
        const restart = yield* SessionRestart.Service
        const sessionID = Session.ID.make("ses_capability_recovery")
        yield* seedSession(sessionID, claimed ? { time_suspended: 123, resume_attempts: 10 } : {})
        yield* resolve.own(Effect.succeed({ id: sessionID }))
        const before = yield* accounting(database)

        expect(resolve.status(sessionID)).toBe("owned-detached")
        yield* restart.resumeSuspendedSessions
        yield* restart.resumeSuspendedSessions

        expect(yield* accounting(database)).toEqual(before)
        expect(resolve.status(sessionID)).toBe("owned-detached")
        yield* assertInert()
      }),
    )
  }

  it.effect("keeps a completed Job pending for an unclaimed owned parent without waking it", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const resolve = yield* SessionResolve.Service
      const jobs = yield* Job.Service
      const restart = yield* SessionRestart.Service
      const parent = Session.ID.make("ses_capability_completed_parent")
      const child = Session.ID.make("ses_capability_completed_child")
      yield* seedSession(parent)
      yield* seedSession(child, { parent_id: parent })
      yield* resolve.own(Effect.succeed({ id: parent }))
      yield* seedJob(
        { kind: "subagent", parentSessionID: parent, childSessionID: child, agent: "explore", description: "Inspect" },
        "completed",
      )
      const pending = yield* jobs.pendingBackground
      const before = yield* accounting(database)

      expect(pending).toMatchObject([{ status: "completed", output: "Recovered result" }])
      yield* restart.resumeSuspendedSessions
      yield* restart.resumeSuspendedSessions

      expect(yield* jobs.pendingBackground).toEqual(pending)
      expect(yield* jobs.get("recovery-job")).toBeUndefined()
      expect(yield* accounting(database)).toEqual(before)
      yield* assertInert()
    }),
  )

  for (const owner of ["parent", "child"] as const) {
    it.effect(`preserves child claims with a capability-owned ${owner} and pending running Job`, () =>
      Effect.gen(function* () {
        const database = yield* Database.Service
        const resolve = yield* SessionResolve.Service
        const jobs = yield* Job.Service
        const restart = yield* SessionRestart.Service
        const parent = Session.ID.make("ses_capability_running_parent")
        const child = Session.ID.make("ses_capability_running_child")
        const orphan = Session.ID.make("ses_capability_orphan_child")
        yield* seedSession(parent, owner === "parent" ? { time_suspended: 789, resume_attempts: 10 } : {})
        yield* seedSession(child, { parent_id: parent, time_suspended: 123, resume_attempts: 10 })
        yield* seedSession(orphan, { parent_id: parent, time_suspended: 456, resume_attempts: 1 })
        yield* resolve.own(Effect.succeed({ id: owner === "parent" ? parent : child }))
        yield* resolve.own(Effect.succeed({ id: orphan }))
        yield* seedJob(
          {
            kind: "subagent",
            parentSessionID: parent,
            childSessionID: child,
            agent: "explore",
            description: "Inspect",
          },
          "running",
        )
        const pending = yield* jobs.pendingBackground
        const before = yield* accounting(database)

        expect(pending).toMatchObject([{ status: "running" }])
        yield* restart.resumeSuspendedSessions
        yield* restart.resumeSuspendedSessions

        expect(yield* jobs.pendingBackground).toEqual(pending)
        expect(yield* jobs.get("recovery-job")).toBeUndefined()
        expect(yield* accounting(database)).toEqual(before)
        yield* assertInert()
      }),
    )
  }

  for (const status of ["running", "completed"] as const) {
    it.effect(`keeps a ${status} shell Job pending for an owned Session`, () =>
      Effect.gen(function* () {
        const database = yield* Database.Service
        const resolve = yield* SessionResolve.Service
        const jobs = yield* Job.Service
        const restart = yield* SessionRestart.Service
        const sessionID = Session.ID.make("ses_capability_shell")
        yield* seedSession(sessionID)
        yield* resolve.own(Effect.succeed({ id: sessionID }))
        yield* seedJob({ kind: "shell", sessionID, shellID: "sh_recovery", command: "echo result" }, status)
        const pending = yield* jobs.pendingBackground
        const before = yield* accounting(database)

        yield* restart.resumeSuspendedSessions

        expect(yield* jobs.pendingBackground).toEqual(pending)
        expect(yield* accounting(database)).toEqual(before)
        yield* assertInert()
      }),
    )
  }
})

function seedSession(
  sessionID: Session.ID,
  values: Partial<Pick<typeof SessionTable.$inferInsert, "time_suspended" | "resume_attempts" | "parent_id">> = {},
) {
  return Effect.gen(function* () {
    const database = yield* Database.Service
    yield* database.db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* database.db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: Project.ID.global,
        slug: sessionID,
        directory: "/project",
        title: sessionID,
        version: "test",
        ...values,
      })
      .run()
      .pipe(Effect.orDie)
  })
}

function seedJob(recovery: Job.Recovery, status: "running" | "completed") {
  // A previous process-local Job registry leaves only its durable record behind.
  return Effect.gen(function* () {
    const jobs = yield* Job.make
    yield* jobs.start({
      id: "recovery-job",
      type: recovery.kind,
      recovery,
      run: status === "running" ? Effect.never : Effect.succeed("Recovered result"),
    })
    yield* jobs.background("recovery-job")
    if (status === "completed") yield* jobs.wait({ id: "recovery-job" })
  }).pipe(Effect.scoped)
}

function accounting(database: Database.Service["Service"]) {
  return database.db
    .select({
      id: SessionTable.id,
      claimed: SessionTable.time_suspended,
      attempts: SessionTable.resume_attempts,
      updated: SessionTable.time_updated,
    })
    .from(SessionTable)
    .orderBy(SessionTable.id)
    .all()
    .pipe(Effect.orDie)
}

function assertInert() {
  return Effect.gen(function* () {
    const database = yield* Database.Service
    const execution = yield* SessionExecution.Service
    const locations = yield* LocationServiceMap.Service
    expect(yield* execution.active).toEqual(new Set())
    expect(yield* database.db.select().from(EventTable).all().pipe(Effect.orDie)).toEqual([])
    expect(yield* database.db.select().from(SessionMessageTable).all().pipe(Effect.orDie)).toEqual([])
    expect(yield* database.db.select().from(SessionInboxTable).all().pipe(Effect.orDie)).toEqual([])
    expect(Array.from(yield* RcMap.keys(locations.rcMap))).toEqual([])
  })
}
