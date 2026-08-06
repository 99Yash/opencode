import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/util/effect/layer-node"
import { FSUtil } from "@opencode-ai/util/fs-util"
import { Formatter } from "@opencode-ai/core/formatter"
import { Location } from "@opencode-ai/core/location"
import { Permission } from "@opencode-ai/core/permission"
import { Session } from "@opencode-ai/core/session"
import { Tool } from "@opencode-ai/core/tool"
import { PatchTool } from "@opencode-ai/core/tool/plugin/patch"
import { WorkspaceEnvironment } from "@opencode-ai/core/workspace/environment"
import { makeLocationNode } from "@opencode-ai/util/effect/app-node"
import { testEffect } from "./lib/effect"
import { toolIdentity, executeTool, registerToolPlugin } from "./lib/tool"
import { hostedLocationLayer, memoryEnvironment, ROOT } from "./lib/workspace"
import type { MemoryEnvironment } from "./lib/workspace"

const sessionID = Session.ID.make("ses_workspace_patch_test")

const assertions: Permission.AssertInput[] = []

const permission = Layer.succeed(
  Permission.Service,
  Permission.Service.of({
    assert: (input) =>
      Effect.sync(() => {
        assertions.push(input)
      }),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)

// Hosted patch must never format nor touch the host filesystem: both die.
const formatter = Layer.mock(Formatter.Service, {
  file: () => Effect.die("hosted patch must not run host formatters"),
})

const poisoned = () => Effect.die("hosted patch must not touch the host filesystem")
const filesystem = Layer.effect(
  FSUtil.Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    return FSUtil.Service.of({
      ...fs,
      stat: poisoned,
      readFile: poisoned,
      writeWithDirs: poisoned,
      remove: poisoned,
    })
  }),
).pipe(Layer.provide(LayerNode.compile(FSUtil.node)))

const withTool = <A, E, R>(memory: MemoryEnvironment, body: (registry: Tool.Interface) => Effect.Effect<A, E, R>) => {
  const environment = Layer.succeed(WorkspaceEnvironment.Service, memory.environment)
  const patchToolNode = makeLocationNode({
    name: "test/workspace-patch-plugin",
    layer: Layer.effectDiscard(registerToolPlugin(PatchTool.Plugin)),
    deps: [Tool.node, Formatter.node, FSUtil.node, Location.node, Permission.node, WorkspaceEnvironment.node],
  })
  return Effect.gen(function* () {
    assertions.length = 0
    return yield* body(yield* Tool.Service)
  }).pipe(
    Effect.provide(
      AppNodeBuilder.build(LayerNode.group([Tool.node, patchToolNode]), [
        [FSUtil.node, filesystem],
        [Location.node, hostedLocationLayer()],
        [Formatter.node, formatter],
        [Permission.node, permission],
        [WorkspaceEnvironment.node, environment],
      ]),
    ),
  )
}

const call = (patchText: string, id = "call-patch") => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id, name: "patch", input: { patchText } },
})

const it = testEffect(Layer.empty)

describe("PatchTool on a hosted location", () => {
  it.effect("applies add, update, and delete through the workspace environment", () => {
    const memory = memoryEnvironment({
      [`${ROOT}/update.txt`]: "before\n",
      [`${ROOT}/remove.txt`]: "remove\n",
    })
    return withTool(memory, (registry) =>
      Effect.gen(function* () {
        const settled = yield* executeTool(
          registry,
          call(
            "*** Begin Patch\n*** Add File: nested/new.txt\n+created\n*** Update File: update.txt\n@@\n-before\n+after\n*** Delete File: remove.txt\n*** End Patch",
          ),
        )
        expect(settled.status).toBe("completed")
        if (settled.status !== "completed") return
        expect(settled.output).toMatchObject({
          applied: [
            { type: "add", resource: "nested/new.txt", target: `${ROOT}/nested/new.txt` },
            { type: "update", resource: "update.txt" },
            { type: "delete", resource: "remove.txt" },
          ],
        })
        expect(memory.contents(`${ROOT}/nested/new.txt`)).toBe("created\n")
        expect(memory.contents(`${ROOT}/update.txt`)).toBe("after\n")
        expect(memory.contents(`${ROOT}/remove.txt`)).toBeUndefined()
        expect(assertions.map((input) => input.action)).toEqual(["edit"])
        expect(assertions[0]?.resources).toEqual(["nested/new.txt", "update.txt", "remove.txt"])
      }),
    )
  })

  it.effect("moves a file through the workspace environment", () => {
    const memory = memoryEnvironment({ [`${ROOT}/old.txt`]: "before\n" })
    return withTool(memory, (registry) =>
      Effect.gen(function* () {
        const settled = yield* executeTool(
          registry,
          call("*** Begin Patch\n*** Update File: old.txt\n*** Move to: moved.txt\n@@\n-before\n+after\n*** End Patch"),
        )
        expect(settled.status).toBe("completed")
        expect(memory.contents(`${ROOT}/old.txt`)).toBeUndefined()
        expect(memory.contents(`${ROOT}/moved.txt`)).toBe("after\n")
      }),
    )
  })

  it.effect("reports a missing update target as a verification failure", () => {
    const memory = memoryEnvironment({})
    return withTool(memory, (registry) =>
      Effect.gen(function* () {
        const settled = yield* executeTool(
          registry,
          call("*** Begin Patch\n*** Update File: missing.txt\n@@\n-before\n+after\n*** End Patch"),
        )
        expect(settled.status).toBe("error")
        if (settled.status !== "error") return
        expect(settled.error?.message).toContain("file does not exist")
      }),
    )
  })

  it.effect("resolves external targets with posix containment", () => {
    const memory = memoryEnvironment({})
    return withTool(memory, (registry) =>
      Effect.gen(function* () {
        yield* executeTool(registry, call("*** Begin Patch\n*** Add File: /outside/new.txt\n+created\n*** End Patch"))
        expect(assertions.map((input) => input.action)).toEqual(["external_directory", "edit"])
        expect(assertions[0]?.metadata).toMatchObject({ filepath: "/outside/new.txt", parentDir: "/outside" })
      }),
    )
  })
})
