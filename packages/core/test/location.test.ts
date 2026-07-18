import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Exit, Layer } from "effect"
import { make } from "effect/unstable/process/ChildProcessSpawner"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Location } from "@opencode-ai/core/location"
import { Project } from "@opencode-ai/core/project"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { WorkspaceEnvironment } from "@opencode-ai/core/workspace/environment"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const workspaceID = WorkspaceV2.ID.make("wrk_test")
const ref = { directory: AbsolutePath.make("/repo/packages/app") }
const projectLayer = Layer.succeed(
  Project.Service,
  Project.Service.of({
    list: () => Effect.succeed([]),
    directories: () => Effect.succeed([]),
    resolve: () =>
      Effect.succeed({
        id: Project.ID.make("project"),
        directory: AbsolutePath.make("/repo"),
        vcs: { type: "git", store: AbsolutePath.make("/repo/.git") },
      }),
    commit: () => Effect.void,
  }),
)
const it = testEffect(AppNodeBuilder.build(Location.boundNode(ref), [[Project.node, projectLayer]]))

describe("Location", () => {
  it.effect("resolves the current project and vcs information", () =>
    Effect.gen(function* () {
      const location = yield* Location.Service

      expect(location.directory).toBe(AbsolutePath.make("/repo/packages/app"))
      expect(location.workspaceID).toBeUndefined()
      expect(location.project.id).toBe(Project.ID.make("project"))
      expect(location.project.directory).toBe(AbsolutePath.make("/repo"))
      expect(location.vcs).toEqual({
        type: "git",
        store: AbsolutePath.make("/repo/.git"),
      })
    }),
  )

  it.live("resolves hosted metadata without reading the host path", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) => {
        const directory = AbsolutePath.make(path.join(tmp.path, "hosted-checkout"))
        const connections = { count: 0 }
        const reads = { count: 0 }
        const unsupported = () => Effect.die("Unsupported fake environment operation")
        const providerEnvironment = WorkspaceEnvironment.Service.of({
          platform: "linux",
          directory,
          process: make(() => unsupported()),
          shell: {
            executable: "/bin/sh",
            args: (command) => ["-c", command],
            environmentOverrides: {},
            detached: false,
          },
          ripgrep: Effect.succeed("/usr/bin/rg"),
          files: {
            resolve: (target) =>
              Effect.succeed({
                canonical: target.includes("symlink") ? "/outside/secret" : target,
                directory: path.posix.dirname(target),
                type: "File",
              }),
            inspect: unsupported,
            read: () =>
              Effect.sync(() => {
                reads.count++
                return new Uint8Array([1])
              }),
            list: unsupported,
            ensureDirectory: unsupported,
            createExclusive: unsupported,
            write: unsupported,
            writeIfUnchanged: unsupported,
            remove: unsupported,
          },
        })
        const workspaceLayer = Layer.succeed(
          WorkspaceV2.Service,
          WorkspaceV2.Service.of({
            create: () => Effect.die("Unsupported fake Workspace operation"),
            get: () =>
              Effect.succeed(
                WorkspaceV2.Info.make({
                  id: workspaceID,
                  name: "Hosted",
                  directory,
                  project: {
                    id: Project.ID.make("hosted-project"),
                    directory,
                  },
                }),
              ),
            borrow: () =>
              Effect.sync(() => {
                connections.count++
                return providerEnvironment
              }),
            connect: () => Effect.die("Unsupported fake Workspace operation"),
            suspend: () => Effect.die("Unsupported fake Workspace operation"),
            remove: () => Effect.die("Unsupported fake Workspace operation"),
          }),
        )
        const hostedRef = { directory, workspaceID }
        const layer = AppNodeBuilder.build(LayerNode.group([Location.node, WorkspaceEnvironment.node]), [
          [Location.node, Location.boundNode(hostedRef)],
          [WorkspaceEnvironment.node, WorkspaceEnvironment.boundNode(hostedRef)],
          [WorkspaceV2.node, workspaceLayer],
        ])
        const invalidLayer = AppNodeBuilder.build(
          Location.boundNode({ directory: AbsolutePath.make(path.join(tmp.path, "outside")), workspaceID }),
          [[WorkspaceV2.node, workspaceLayer]],
        )
        return Effect.gen(function* () {
          expect(
            yield* Effect.promise(() =>
              fs.stat(directory).then(
                () => true,
                () => false,
              ),
            ),
          ).toBe(false)

          const location = yield* Location.Service
          const environment = yield* WorkspaceEnvironment.Service
          expect(location.directory).toBe(directory)
          expect(location.workspaceID).toBe(workspaceID)
          expect(location.project).toEqual({
            id: Project.ID.make("hosted-project"),
            directory,
          })
          expect(environment.directory).toBe(directory)
          expect(environment.platform).toBe("linux")
          expect(connections.count).toBe(0)

          expect(yield* environment.files.read(path.posix.join(directory, "file.txt"))).toEqual(new Uint8Array([1]))
          expect(connections.count).toBe(1)
          expect(reads.count).toBe(1)

          const outsideFile = yield* environment.files.read("/outside/secret").pipe(Effect.flip)
          expect(outsideFile.operation).toBe("containment")
          const symlink = yield* environment.files.read(path.posix.join(directory, "symlink")).pipe(Effect.flip)
          expect(symlink.operation).toBe("containment")
          expect(reads.count).toBe(1)

          const invalid = yield* Location.Service.pipe(Effect.provide(invalidLayer), Effect.exit)
          expect(Exit.isFailure(invalid)).toBe(true)
        }).pipe(Effect.provide(layer))
      }),
    ),
  )
})
