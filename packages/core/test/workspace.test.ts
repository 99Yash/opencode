import { describe, expect } from "bun:test"
import { Deferred, Effect, Exit, Fiber, Scope } from "effect"
import { adjust } from "effect/testing/TestClock"
import { eq } from "drizzle-orm"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { AppProcess } from "@opencode-ai/core/process"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { WorkspaceTable } from "@opencode-ai/core/control-plane/workspace.sql"
import { Sandbox } from "@opencode-ai/core/workspace/sandbox"
import { WorkspaceEnvironment } from "@opencode-ai/core/workspace/environment"
import { testEffect } from "./lib/effect"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, Sandbox.registryNode, WorkspaceV2.node, AppProcess.node])),
)

describe("WorkspaceV2", () => {
  it.effect("loads metadata without connecting and shares a scoped connection", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const process = yield* AppProcess.Service
      const registry = yield* Sandbox.RegistryService
      const workspace = yield* WorkspaceV2.Service
      const id = WorkspaceV2.ID.make("wrk_hosted")
      const projectID = Project.ID.make("hosted-project")
      const directory = AbsolutePath.make("/workspace/repo")
      const lifecycle = {
        created: [] as string[],
        connected: [] as Sandbox.Binding[],
        reconciled: 0,
        released: 0,
        suspended: 0,
        deleted: [] as Sandbox.Binding[],
        failDelete: false,
      }
      const suspendStarted = yield* Deferred.make<void>()
      const finishSuspend = yield* Deferred.make<void>()
      const unsupported = (operation: string) => Effect.fail(new WorkspaceEnvironment.Error({ operation }))
      const environment = WorkspaceEnvironment.Service.of({
        platform: "linux",
        directory,
        process,
        shell: {
          executable: "/bin/sh",
          args: (command) => ["-c", command],
          environmentOverrides: {},
          detached: false,
        },
        ripgrep: Effect.succeed("/usr/bin/rg"),
        files: {
          inspect: () => unsupported("inspect"),
          resolve: () => unsupported("resolve"),
          read: () => unsupported("read"),
          list: () => unsupported("list"),
          ensureDirectory: () => unsupported("ensureDirectory"),
          createExclusive: () => unsupported("createExclusive"),
          write: () => unsupported("write"),
          writeIfUnchanged: () => unsupported("writeIfUnchanged"),
          remove: () => unsupported("remove"),
        },
      })

      yield* db
        .insert(ProjectTable)
        .values({
          id: projectID,
          worktree: directory,
          sandboxes: [],
          time_created: 1,
          time_updated: 1,
        })
        .run()
      yield* db
        .insert(WorkspaceTable)
        .values({
          id,
          type: "fake",
          name: "Hosted",
          directory,
          extra: { kind: "sandbox", version: 1, binding: { sandbox: "one" } },
          project_id: projectID,
          time_used: 1,
        })
        .run()
      yield* registry.register({
        key: "fake",
        create: (input) =>
          Effect.sync(() => {
            lifecycle.created.push(input.identity)
            return { sandbox: input.identity }
          }),
        decode: Effect.succeed,
        connect: (binding) =>
          Effect.acquireRelease(
            Effect.sync(() => {
              lifecycle.connected.push(binding)
              return { binding: { sandbox: "live", retired: "one" }, environment }
            }),
            () => Effect.sync(() => lifecycle.released++),
          ),
        suspend: () =>
          Deferred.succeed(suspendStarted, undefined).pipe(
            Effect.andThen(Deferred.await(finishSuspend)),
            Effect.tap(() => Effect.sync(() => lifecycle.suspended++)),
            Effect.as({ snapshot: "snap-one", retired: "live" }),
          ),
        reconcile: (binding) =>
          Effect.sync(() => {
            lifecycle.reconciled++
            const next: Sandbox.Binding = "snapshot" in binding ? { snapshot: binding.snapshot } : { sandbox: "live" }
            return next
          }),
        delete: (binding) => {
          if (lifecycle.failDelete) {
            return Effect.fail(new Sandbox.Error({ provider: "fake", operation: "delete" }))
          }
          return Effect.sync(() => lifecycle.deleted.push(binding))
        },
      })

      expect(yield* workspace.get(id)).toEqual({
        id,
        name: "Hosted",
        directory,
        project: { id: projectID, directory },
      })
      expect(lifecycle.connected).toHaveLength(0)

      const borrowed = yield* Effect.all([workspace.borrow(id), workspace.borrow(id)]).pipe(Effect.scoped)
      expect(borrowed[0]).toBe(environment)
      expect(borrowed[1]).toBe(environment)
      expect(lifecycle.connected).toHaveLength(1)
      expect(lifecycle.reconciled).toBe(1)
      expect(lifecycle.released).toBe(0)
      const placement = yield* db.select().from(WorkspaceTable).where(eq(WorkspaceTable.id, id)).get()
      expect(placement?.extra).toEqual({
        kind: "sandbox",
        version: 1,
        binding: { sandbox: "live" },
      })

      yield* adjust("1 minute")
      yield* Effect.yieldNow
      expect(lifecycle.released).toBe(1)

      const invalidID = WorkspaceV2.ID.make("wrk_invalid")
      yield* db
        .insert(WorkspaceTable)
        .values({
          id: invalidID,
          type: "fake",
          name: "Legacy",
          directory,
          extra: { sandbox: "legacy-adapter-state" },
          project_id: projectID,
          time_used: 1,
        })
        .run()
      const invalid = yield* workspace.borrow(invalidID).pipe(Effect.scoped, Effect.flip)
      expect(invalid._tag).toBe("Workspace.InvalidError")
      expect(lifecycle.connected).toHaveLength(1)

      const retryID = WorkspaceV2.ID.make("wrk_retry")
      const retry = { attempts: 0 }
      yield* db
        .insert(WorkspaceTable)
        .values({
          id: retryID,
          type: "flaky",
          name: "Retry",
          directory,
          extra: { kind: "sandbox", version: 1, binding: { sandbox: "retry" } },
          project_id: projectID,
          time_used: 1,
        })
        .run()
      yield* registry.register({
        key: "flaky",
        create: () => Effect.die("Unexpected create"),
        decode: Effect.succeed,
        connect: (binding) =>
          Effect.sync(() => ++retry.attempts).pipe(
            Effect.flatMap((attempt) =>
              attempt === 1 ? Effect.die("Transient provider defect") : Effect.succeed({ binding, environment }),
            ),
          ),
        suspend: () => Effect.die("Unexpected suspend"),
        reconcile: Effect.succeed,
        delete: () => Effect.die("Unexpected delete"),
      })

      expect(Exit.isFailure(yield* workspace.borrow(retryID).pipe(Effect.scoped, Effect.exit))).toBe(true)
      expect(yield* workspace.borrow(retryID).pipe(Effect.scoped)).toBe(environment)
      expect(retry.attempts).toBe(2)

      const created = yield* workspace.create({
        provider: "fake",
        name: "Created",
        directory,
        projectID,
      })
      expect(created).toEqual({
        id: created.id,
        name: "Created",
        directory,
        project: { id: projectID, directory },
      })
      expect(lifecycle.created.at(-1)).toBe(created.id)

      const failedCreate = yield* workspace
        .create({
          provider: "fake",
          name: "Invalid project",
          directory,
          projectID: Project.ID.make("missing-project"),
        })
        .pipe(Effect.exit)
      expect(Exit.isFailure(failedCreate)).toBe(true)
      const failedIdentity = lifecycle.created.at(-1)
      if (!failedIdentity) return yield* Effect.die("Missing failed create identity")
      expect(lifecycle.deleted).toContainEqual({ sandbox: failedIdentity })

      const active = yield* Scope.make()
      yield* workspace.borrow(id).pipe(Scope.provide(active))
      const suspendInvoked = yield* Deferred.make<void>()
      const suspendFiber = yield* Deferred.succeed(suspendInvoked, undefined).pipe(
        Effect.andThen(workspace.suspend(id)),
        Effect.forkChild,
      )
      yield* Deferred.await(suspendInvoked)
      yield* Effect.yieldNow
      expect(yield* Deferred.isDone(suspendStarted)).toBe(false)

      const admitted = yield* Deferred.make<void>()
      const borrowFiber = yield* workspace.borrow(id).pipe(
        Effect.tap(() => Deferred.succeed(admitted, undefined)),
        Effect.scoped,
        Effect.forkChild,
      )
      yield* Effect.yieldNow
      expect(yield* Deferred.isDone(admitted)).toBe(false)

      yield* Scope.close(active, Exit.void)
      yield* Deferred.await(suspendStarted)
      expect(yield* Deferred.isDone(admitted)).toBe(false)

      yield* Deferred.succeed(finishSuspend, undefined)
      yield* Fiber.join(suspendFiber)
      yield* Fiber.join(borrowFiber)
      expect(lifecycle.suspended).toBe(1)
      expect(lifecycle.connected).toContainEqual({ snapshot: "snap-one" })
      expect((yield* db.select().from(WorkspaceTable).where(eq(WorkspaceTable.id, id)).get())?.extra).toEqual({
        kind: "sandbox",
        version: 1,
        binding: { sandbox: "live" },
      })

      lifecycle.failDelete = true
      const deleteError = yield* workspace.remove(created.id).pipe(Effect.flip)
      expect(deleteError._tag).toBe("Sandbox.Error")
      if (deleteError._tag !== "Sandbox.Error") return yield* Effect.die("Unexpected delete error")
      expect(deleteError.operation).toBe("delete")
      expect((yield* workspace.get(created.id)).id).toBe(created.id)
      lifecycle.failDelete = false
      yield* workspace.remove(created.id)
      expect((yield* workspace.get(created.id).pipe(Effect.flip))._tag).toBe("Workspace.NotFoundError")
      expect(lifecycle.deleted).toContainEqual({ sandbox: "live" })
    }),
  )
})
