import { afterAll, expect, test } from "bun:test"
import { cp, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import type { Tool } from "@opencode-ai/schema/tool"
import type { StandardJSONSchemaV1, StandardSchemaV1 } from "@standard-schema/spec"
import { Effect, Schema } from "effect"
import { Plugin } from "../src/effect/index.js"
import type { Context } from "../src/promise/plugin.js"

const fixture = prepareAdapter()

afterAll(async () => rm((await fixture).directory, { recursive: true, force: true }))

test("owns Effect callbacks and finalizers inside the Promise plugin lifecycle", async () => {
  const events: string[] = []
  const host = {
    signal: new AbortController().signal,
    app: {},
    options: {},
    agent: {},
    aisdk: {
      hook: async (_name: string, callback: () => Promise<void>) => {
        events.push("registered")
        await callback(undefined, { signal: new AbortController().signal })
        return { dispose: async () => void events.push("disposed") }
      },
    },
    catalog: { provider: {}, model: {} },
    command: {},
    event: {},
    integration: { connect: {}, oauth: {}, command: {}, connection: {} },
    mcp: {},
    plugin: {},
    reference: {},
    session: {},
    shell: {},
    skill: {},
    storage: {},
    tool: {},
    websearch: {},
  } as unknown as Context
  const plugin = Plugin.define({
    id: "lifecycle",
    effect: (context) =>
      Effect.gen(function* () {
        yield* context.aisdk.hook("sdk", () => Effect.sync(() => events.push("callback")))
        yield* Effect.addFinalizer(() => Effect.sync(() => events.push("finalized")))
      }),
  })

  const cleanup = await plugin.setup(host)
  expect(events).toEqual(["registered", "callback"])
  expect(cleanup).toBeFunction()
  if (cleanup) await cleanup()
  expect(events).toEqual(["registered", "callback", "finalized", "disposed"])
})

test("interrupts Effect setup through the Promise setup signal", async () => {
  const controller = new AbortController()
  const events: string[] = []
  const plugin = Plugin.define({
    id: "interrupt-setup",
    effect: () =>
      Effect.sync(() => events.push("started")).pipe(
        Effect.andThen(Effect.never),
        Effect.ensuring(Effect.sync(() => events.push("finalized"))),
      ),
  })
  const setup = plugin.setup({
    signal: controller.signal,
    app: {},
    options: {},
    agent: {},
    aisdk: {},
    catalog: { provider: {}, model: {} },
    command: {},
    event: {},
    integration: { connect: {}, oauth: {}, command: {}, connection: {} },
    mcp: {},
    plugin: {},
    reference: {},
    session: {},
    shell: {},
    skill: {},
    storage: {},
    tool: {},
    websearch: {},
  } as unknown as Context)
  while (events.length === 0) await Bun.sleep(0)
  controller.abort()

  await expect(setup).rejects.toBeDefined()
  expect(events).toEqual(["started", "finalized"])
})

test("converts schemas entirely inside the plugin Effect runtime", async () => {
  const prepared = await fixture
  const input = prepared.toStandardSchema(prepared.Schema.FiniteFromString, "input") as StandardSchemaV1 &
    StandardJSONSchemaV1
  const output = prepared.toStandardSchema(prepared.Schema.FiniteFromString, "output") as StandardSchemaV1 &
    StandardJSONSchemaV1

  expect(Schema.isSchema(input)).toBe(false)
  expect(await input["~standard"].validate("42")).toEqual({ value: 42 })
  expect(input["~standard"].jsonSchema.input({ target: "draft-2020-12" })).toMatchObject({ type: "string" })
  expect(await output["~standard"].validate(42)).toEqual({ value: "42" })
  expect(output["~standard"].jsonSchema.output({ target: "draft-2020-12" })).toMatchObject({ type: "string" })
})

test("rejects schemas from a different plugin Effect runtime", async () => {
  const prepared = await fixture
  expect(() => prepared.toStandardSchema(Schema.String, "input")).toThrow("must use the plugin's Effect peer")
})

async function prepareAdapter() {
  const directory = await mkdtemp(path.join(tmpdir(), "opencode-effect-adapter-"))
  await cp(
    path.dirname(fileURLToPath(import.meta.resolve("effect/package.json"))),
    path.join(directory, "node_modules", "effect"),
    { recursive: true },
  )
  await cp(new URL("../src/effect/tool-schema.ts", import.meta.url), path.join(directory, "tool-schema.ts"))
  const adapter = (await import(pathToFileURL(path.join(directory, "tool-schema.ts")).href)) as {
    toStandardSchema: (schema: Tool.ValueSchema, direction: "input" | "output") => Tool.ValueSchema
  }
  const runtime = (await import(
    pathToFileURL(path.join(directory, "node_modules", "effect", "dist", "index.js")).href
  )) as {
    Schema: typeof Schema
  }
  return { directory, toStandardSchema: adapter.toStandardSchema, Schema: runtime.Schema }
}
