import { expect } from "bun:test"
import { Agent } from "@opencode-ai/schema/agent"
import { LayerNode } from "@opencode-ai/util/effect/layer-node"
import { Effect, Schema } from "effect"
import { Image } from "../src/image"
import { PluginHooks } from "../src/plugin/hooks"
import { SessionSchema } from "../src/session/schema"
import { SessionMessage } from "../src/session/message"
import { Tool } from "../src/tool"
import { testEffect } from "./lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([PluginHooks.node, Image.node])))
const identity = {
  sessionID: SessionSchema.ID.make("ses_tool_values"),
  agent: Agent.ID.make("build"),
  messageID: SessionMessage.ID.make("msg_tool_values"),
}
const call = (name: string, input: unknown): Parameters<Tool.Snapshot["execute"]>[0] => ({
  ...identity,
  call: { type: "tool-call", id: `call_${name}`, name, input },
})
const echo: Tool.Info = {
  name: "echo",
  description: "Echo a value",
  input: Schema.Struct({ value: Schema.String }),
  output: Schema.String,
  execute: ({ value }) => Effect.succeed({ output: value }),
}

it.effect("value snapshots preserve definitions and executors after sampling and replacement", () =>
  Effect.gen(function* () {
    const tool = { ...echo, options: { namespace: "demo", codemode: false } }
    const values: Tool.Info[] = [tool]
    const first = yield* Tool.snapshot(values)
    tool.execute = () => Effect.succeed({ output: "changed executor" })
    tool.description = "Changed description"
    values[0] = {
      ...tool,
      input: Schema.Struct({ count: Schema.Finite }),
      output: Schema.Finite,
      execute: ({ count }) => Effect.succeed({ output: count + 1 }),
    }
    const second = yield* Tool.snapshot(values)
    values.length = 0
    expect((yield* Tool.snapshot(values)).definitions.map((tool) => tool.name)).toEqual(["execute"])

    expect(first.definitions[0]?.description).toBe("Echo a value")
    expect(first.definitions[0]?.inputSchema.properties).toEqual({ value: { type: "string" } })
    expect(second.definitions[0]?.description).toBe("Changed description")
    expect(second.definitions[0]?.inputSchema.properties).toEqual({ count: { type: "number" } })
    expect(yield* first.execute(call("demo_echo", { value: "original" }))).toEqual({
      output: "original",
      content: [{ type: "text", text: "original" }],
    })
    expect((yield* second.execute(call("demo_echo", { count: 2 }))).output).toBe(3)
    expect(yield* first.execute(call("demo_echo", { count: 2 })).pipe(Effect.flip)).toBeInstanceOf(Tool.Error)
    expect(yield* second.execute(call("demo_echo", { value: "original" })).pipe(Effect.flip)).toBeInstanceOf(Tool.Error)
  }),
)

it.effect("value snapshots reuse name normalization, validation, and last-valid precedence", () =>
  Effect.gen(function* () {
    const tool = { ...echo, name: "echo.text", options: { namespace: "demo.tools", codemode: false } }
    const snapshot = yield* Tool.snapshot([
      tool,
      { ...tool, name: "echo_text", execute: () => Effect.succeed({ output: "latest" }) },
      { ...tool, options: { namespace: "invalid namespace", codemode: false } },
      { ...echo, name: "execute", options: { codemode: false } },
    ])
    expect(snapshot.definitions.map((tool) => tool.name)).toEqual(["demo_tools_echo_text", "execute"])
    expect((yield* snapshot.execute(call("demo_tools_echo_text", { value: "input" }))).output).toBe("latest")

    const invalidOutput = yield* Tool.snapshot([
      { ...echo, options: { codemode: false }, execute: () => Effect.succeed({ output: 1 }) },
    ])
    expect((yield* invalidOutput.execute(call("echo", { value: "input" })).pipe(Effect.flip)).message).toContain(
      "Tool returned an invalid value for its output schema",
    )
  }),
)

it.live("value snapshots default tools into CodeMode and retain executable catalog entries", () =>
  Effect.gen(function* () {
    const snapshot = yield* Tool.snapshot([{ ...echo, options: { namespace: "demo.tools" } }])
    expect(snapshot.definitions.map((tool) => tool.name)).toEqual(["execute"])
    expect(snapshot.codeModeCatalog?.map((tool) => tool.path)).toEqual(["demo.tools.echo"])
    expect(yield* snapshot.execute(call("demo_tools_echo", { value: "input" })).pipe(Effect.flip)).toEqual(
      new Tool.Error({ message: "Unknown tool: demo_tools_echo" }),
    )
    expect(
      yield* snapshot.execute(call("execute", { code: 'return await tools.demo.tools.echo({ value: "input" })' })),
    ).toMatchObject({
      content: [{ type: "text", text: "input" }],
      metadata: { toolCalls: [{ tool: "demo.tools.echo", status: "completed", input: { value: "input" } }] },
    })
  }),
)

it.effect("value snapshot permissions filter visibility without authorizing execution", () =>
  Effect.gen(function* () {
    const tools = [{ ...echo, options: { permission: "read", codemode: false } }]
    const visible = yield* Tool.snapshot(tools, [{ action: "read", resource: "private/*", effect: "deny" }])
    expect((yield* visible.execute(call("echo", { value: "private/file.ts" }))).output).toBe("private/file.ts")
    const hidden = yield* Tool.snapshot(tools, [{ action: "read", resource: "*", effect: "deny" }])
    expect(hidden.definitions.map((tool) => tool.name)).toEqual(["execute"])
    expect(yield* hidden.execute(call("echo", { value: "input" })).pipe(Effect.flip)).toBeInstanceOf(Tool.Error)
    const directOnly = yield* Tool.snapshot(tools, [{ action: "execute", resource: "*", effect: "deny" }])
    expect(directOnly.definitions.map((tool) => tool.name)).toEqual(["echo"])
    expect(directOnly.codeModeCatalog).toBeUndefined()
  }),
)

it.live("value snapshots use externally scoped hooks and image normalization", () =>
  Effect.gen(function* () {
    const hooks = yield* PluginHooks.Service
    const image = yield* Image.Service
    const seen: string[] = []
    yield* image.transform((draft) => draft.configure({ autoResize: false, maxBase64Bytes: 0 }))
    yield* hooks.register("tool", "execute.before", (event) =>
      Effect.sync(() => {
        seen.push(`before:${event.tool}`)
        event.input = { value: "reviewed" }
      }),
    )
    yield* hooks.register("tool", "execute.after", (event) =>
      Effect.sync(() => {
        seen.push(`after:${event.tool}`)
        if (event.status !== "completed") return
        event.result = {
          ...event.result,
          content: [
            { type: "text", text: "reviewed content" },
            {
              type: "file",
              mime: "image/png",
              uri: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
            },
          ],
        }
      }),
    )
    const snapshot = yield* Tool.snapshot([{ ...echo, options: { codemode: false } }])
    expect(yield* hooks.has("tool", "execute.before")).toBe(true)
    expect(yield* snapshot.execute(call("echo", { value: "input" }))).toEqual({
      output: "reviewed",
      content: [
        { type: "text", text: "reviewed content" },
        { type: "text", text: "[1 image omitted: could not be resized below the image size limit.]" },
      ],
    })
    expect(seen).toEqual(["before:echo", "after:echo"])
  }),
)
