import { describe, expect } from "bun:test"
import { mkdtempSync } from "fs"
import { mkdtemp } from "fs/promises"
import { tmpdir } from "os"
import path from "path"
import { Effect, Layer, Schema } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Bus } from "@opencode-ai/core/bus"
import { Database } from "@opencode-ai/core/database/database"
import { FileMutation } from "@opencode-ai/core/file-mutation"
import { FileSystem } from "@opencode-ai/core/filesystem"
import { Location } from "@opencode-ai/core/location"
import { LocationMutation } from "@opencode-ai/core/location-mutation"
import { LocationServiceMap } from "@opencode-ai/core/location-service-map"
import { Project } from "@opencode-ai/core/project"
import { AbsolutePath, RelativePath } from "@opencode-ai/core/schema"
import { Shell } from "@opencode-ai/core/shell"
import { Workspace } from "@opencode-ai/core/workspace"
import { WorkspaceDriver } from "@opencode-ai/core/workspace/driver"
import { AppProcess } from "@opencode-ai/util/process"
import { LayerNode } from "@opencode-ai/util/effect/layer-node"
import { testEffect } from "./lib/effect"
import { directoryEnvironment } from "./lib/workspace"

const FakeBinding = Schema.Struct({ root: Schema.String })

// The driver spawns through whatever AppProcess the test resolved; the holder
// bridges module-scope driver construction and effect-scope service access.
const state = { spawner: undefined as AppProcess.Interface | undefined, connects: 0 }

const driver = WorkspaceDriver.make({
  create: () =>
    Effect.promise(async () => {
      const root = await mkdtemp(path.join(tmpdir(), "opencode-workspace-e2e-"))
      return { binding: { root }, root }
    }),
  connect: (binding) =>
    Schema.decodeUnknownEffect(FakeBinding)(binding).pipe(
      Effect.mapError((cause) => new WorkspaceDriver.Error({ provider: "fake", cause })),
      Effect.map((decoded) => {
        state.connects++
        return directoryEnvironment(decoded.root, (command) =>
          Effect.suspend(() => {
            if (!state.spawner) return Effect.die(new Error("spawner not resolved yet"))
            return state.spawner.spawn(command)
          }),
        )
      }),
    ),
  destroy: () => Effect.void,
})

const registry = Layer.succeed(
  WorkspaceDriver.RegistryService,
  WorkspaceDriver.RegistryService.of(WorkspaceDriver.registry({ fake: driver })),
)

// Outer and hoisted location graphs must share one durable database, like the
// production file-backed configuration; :memory: would give each its own.
const databaseFile = path.join(mkdtempSync(path.join(tmpdir(), "opencode-workspace-db-")), "e2e.db")

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, Bus.node, Workspace.node, AppProcess.node, LocationServiceMap.node]),
    [
      [Database.node, Database.configured({ path: databaseFile })],
      [WorkspaceDriver.registryNode, registry],
    ],
  ),
)

describe("hosted workspace end to end", () => {
  it.live("creates, works inside, evicts, and reconnects", () =>
    Effect.gen(function* () {
      state.spawner = yield* AppProcess.Service

      const workspaces = yield* Workspace.Service
      const created = yield* workspaces.create({ provider: "fake" })
      expect(created.provider).toBe("fake")

      // Metadata read round-trips through sqlite without touching the driver.
      const fetched = yield* workspaces.get(created.id)
      expect(fetched.root).toBe(created.root)

      const locations = yield* LocationServiceMap.Service
      const ref = Location.Ref.make({
        directory: AbsolutePath.make(created.root),
        workspaceID: created.id,
      })

      yield* Effect.gen(function* () {
        const location = yield* Location.Service
        expect(location.project.id).toBe(Project.ID.global)
        expect(String(location.directory)).toBe(created.root)

        const mutation = yield* LocationMutation.Service
        const mutations = yield* FileMutation.Service
        const target = yield* mutation.resolve({ path: "hello.txt" })
        yield* mutations.write({ target, content: "hello from the workspace\n" })

        const shell = yield* Shell.Service
        const command = yield* shell.create({
          command: "printf 'from-bash' > bash.txt && cat hello.txt",
          timeout: 30_000,
        })
        const finished = yield* shell.wait(command.id)
        expect(finished.status).toBe("exited")
        const output = yield* shell.output(command.id)
        expect(output.output).toContain("hello from the workspace")

        const filesystem = yield* FileSystem.Service
        const fromBash = yield* filesystem.read({ path: RelativePath.make("bash.txt") })
        expect(new TextDecoder().decode(fromBash.content)).toBe("from-bash")
      }).pipe(Effect.provide(locations.get(ref)))

      expect(state.connects).toBe(1)

      // Evict the cached graph, then reconnect through the driver: the
      // workspace contents survive because the binding names durable state.
      yield* locations.invalidate(ref)

      yield* Effect.gen(function* () {
        const filesystem = yield* FileSystem.Service
        const hello = yield* filesystem.read({ path: RelativePath.make("hello.txt") })
        expect(new TextDecoder().decode(hello.content)).toBe("hello from the workspace\n")
        const fromBash = yield* filesystem.read({ path: RelativePath.make("bash.txt") })
        expect(new TextDecoder().decode(fromBash.content)).toBe("from-bash")
      }).pipe(Effect.provide(locations.get(ref)))

      expect(state.connects).toBe(2)
    }),
  )
})
