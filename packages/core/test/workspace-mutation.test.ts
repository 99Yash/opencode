import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { FileMutation } from "@opencode-ai/core/file-mutation"
import { Location } from "@opencode-ai/core/location"
import { LocationMutation } from "@opencode-ai/core/location-mutation"
import { WorkspaceEnvironment } from "@opencode-ai/core/workspace/environment"
import { LayerNode } from "@opencode-ai/util/effect/layer-node"
import { testEffect } from "./lib/effect"
import { hostedLocationLayer, memoryEnvironment } from "./lib/workspace"

const memory = memoryEnvironment({
  "/workspace/README.md": "# hello\n",
  "/workspace/src/index.ts": "export {}\n",
})

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([LocationMutation.hostedNode, FileMutation.hostedNode]), [
    [WorkspaceEnvironment.node, Layer.succeed(WorkspaceEnvironment.Service, memory.environment)],
    [Location.node, hostedLocationLayer()],
  ]),
)

describe("hosted mutation", () => {
  it.effect("resolves an existing file to its canonical path and relative resource", () =>
    Effect.gen(function* () {
      const mutation = yield* LocationMutation.Service
      const target = yield* mutation.resolve({ path: "README.md" })
      expect(target.canonical).toBe("/workspace/README.md")
      expect(target.resource).toBe("README.md")
      expect(target.externalDirectory).toBeUndefined()
    }),
  )

  it.effect("resolves a missing path below an existing directory", () =>
    Effect.gen(function* () {
      const mutation = yield* LocationMutation.Service
      const target = yield* mutation.resolve({ path: "src/created/new.ts" })
      expect(target.canonical).toBe("/workspace/src/created/new.ts")
      expect(target.resource).toBe("src/created/new.ts")
    }),
  )

  it.effect("rejects paths outside the workspace instead of granting external access", () =>
    Effect.gen(function* () {
      const mutation = yield* LocationMutation.Service
      const error = yield* mutation.resolve({ path: "/etc/passwd" }).pipe(Effect.flip)
      expect(error).toMatchObject({ _tag: "LocationMutation.PathError", reason: "outside_workspace" })
    }),
  )

  it.effect("writes new and existing files through the environment", () =>
    Effect.gen(function* () {
      const mutation = yield* LocationMutation.Service
      const files = yield* FileMutation.Service

      const created = yield* mutation.resolve({ path: "notes/todo.md" })
      const first = yield* files.write({ target: created, content: "- ship it\n" })
      expect(first.existed).toBe(false)
      expect(memory.contents("/workspace/notes/todo.md")).toBe("- ship it\n")

      const second = yield* files.writeTextPreservingBom({ target: created, content: "- shipped\n" })
      expect(second.existed).toBe(true)
      expect(memory.contents("/workspace/notes/todo.md")).toBe("- shipped\n")
    }),
  )
})
