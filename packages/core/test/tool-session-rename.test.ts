import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Agent } from "@opencode-ai/core/agent"
import { Image } from "@opencode-ai/core/image"
import { Permission } from "@opencode-ai/core/permission"
import { PluginRuntime } from "@opencode-ai/core/plugin/runtime"
import { Session } from "@opencode-ai/core/session"
import { Tool } from "@opencode-ai/core/tool"
import { SessionRenameTool } from "@opencode-ai/core/tool/plugin/session-rename"
import { makeLocationNode } from "@opencode-ai/util/effect/app-node"
import { LayerNode } from "@opencode-ai/util/effect/layer-node"
import { imagePassthrough } from "./lib/image"
import { testEffect } from "./lib/effect"
import { executeTool, registerToolPlugin, toolDefinitions, toolIdentity } from "./lib/tool"

const currentSessionID = Session.ID.make("ses_session_rename_current")
const otherSessionID = Session.ID.make("ses_session_rename_other")
const renamed: Array<{ sessionID: Session.ID; title: string }> = []
const assertions: Permission.AssertInput[] = []
let deny = false

const runtime = Layer.succeed(
  PluginRuntime.Service,
  PluginRuntime.Service.of({
    session: {
      get: () => Effect.die("unused"),
      create: () => Effect.die("unused"),
      messages: () => Effect.die("unused"),
      prompt: () => Effect.die("unused"),
      generate: () => Effect.die("unused"),
      command: () => Effect.die("unused"),
      resume: () => Effect.die("unused"),
      interrupt: () => Effect.die("unused"),
      synthetic: () => Effect.die("unused"),
      rename: (input) => Effect.sync(() => void renamed.push(input)),
      wait: () => Effect.die("unused"),
    },
    job: {
      start: () => Effect.die("unused"),
      wait: () => Effect.die("unused"),
      block: () => Effect.die("unused"),
      background: () => Effect.die("unused"),
      cancel: () => Effect.die("unused"),
    },
    location: {
      agent: {
        list: () => Effect.die("unused"),
      },
    },
  }),
)

const permission = Layer.succeed(
  Permission.Service,
  Permission.Service.of({
    assert: (input) =>
      Effect.sync(() => assertions.push(input)).pipe(
        Effect.andThen(
          deny
            ? Effect.fail(
                new Permission.BlockedError({
                  rules: [],
                  permission: input.action,
                  resources: input.resources,
                }),
              )
            : Effect.void,
        ),
      ),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)

const sessionRenameToolNode = makeLocationNode({
  name: "test/session-rename-tool-plugin",
  layer: Layer.effectDiscard(registerToolPlugin(SessionRenameTool.Plugin)),
  deps: [Tool.node, Permission.node, PluginRuntime.node],
})

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Tool.node, sessionRenameToolNode]), [
    [Permission.node, permission],
    [PluginRuntime.node, runtime],
    [Image.node, imagePassthrough],
  ]),
)

describe("SessionRenameTool", () => {
  it.effect("registers directly and confines rename to the invocation session", () =>
    Effect.gen(function* () {
      renamed.length = 0
      assertions.length = 0
      deny = false
      const registry = yield* Tool.Service
      const snapshot = yield* registry.snapshot()

      expect(snapshot.definitions.map((tool) => tool.name)).toEqual(["sessionRename", "execute"])
      expect(snapshot.codeModeCatalog?.some((tool) => tool.path === "sessionRename")).toBe(false)
      expect(
        yield* executeTool(registry, {
          sessionID: currentSessionID,
          ...toolIdentity,
          call: {
            type: "tool-call",
            id: "call-session-rename",
            name: "sessionRename",
            input: { title: "\n Focused\n title\t", sessionID: otherSessionID },
          },
        }),
      ).toEqual({
        status: "completed",
        output: { title: "Focused title" },
        content: [{ type: "text", text: "Renamed the current session to: Focused title" }],
        metadata: { title: "Focused title" },
      })
      expect(renamed).toEqual([{ sessionID: currentSessionID, title: "Focused title" }])
      expect(assertions).toMatchObject([
        {
          action: "sessionRename",
          resources: ["*"],
          sessionID: currentSessionID,
          agent: Agent.ID.make("build"),
          source: { type: "tool", messageID: toolIdentity.messageID, callID: "call-session-rename" },
        },
      ])
    }),
  )

  it.effect("filters catalog denial and enforces leaf permission", () =>
    Effect.gen(function* () {
      renamed.length = 0
      deny = true
      const registry = yield* Tool.Service

      expect(
        (yield* toolDefinitions(registry, [{ action: "sessionRename", resource: "*", effect: "deny" }])).map(
          (tool) => tool.name,
        ),
      ).toEqual(["execute"])
      expect(
        yield* executeTool(registry, {
          sessionID: currentSessionID,
          ...toolIdentity,
          call: {
            type: "tool-call",
            id: "call-session-rename-denied",
            name: "sessionRename",
            input: { title: "Denied title" },
          },
        }),
      ).toEqual({
        status: "error",
        error: { type: "permission.rejected", message: "Permission denied: sessionRename" },
      })
      expect(renamed).toEqual([])
      deny = false
    }),
  )
})
