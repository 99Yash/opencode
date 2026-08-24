import { afterAll, expect, test } from "bun:test"
import { cp, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import type { Tool } from "@opencode-ai/schema/tool"
import type { StandardJSONSchemaV1, StandardSchemaV1 } from "@standard-schema/spec"
import { Effect, Schema } from "effect"
import { instanceSafeContext } from "../src/effect/tool-schema.js"

const fixture = prepareAdapter()

afterAll(async () => rm((await fixture).directory, { recursive: true, force: true }))

test("prepares tools at the host plugin boundary", async () => {
  const registered: Array<Tool.Info> = []
  const context = {
    tool: {
      transform: (callback: (draft: { add: (tool: Tool.Info) => void }) => void) => {
        callback({ add: (tool) => registered.push(tool) })
        return Effect.succeed({ dispose: Effect.void })
      },
    },
  } as unknown as Parameters<typeof instanceSafeContext>[0]

  await Effect.runPromise(
    Effect.scoped(
      instanceSafeContext(context).tool.transform((draft) =>
        draft.add({
          name: "create",
          description: "Create",
          input: Schema.Struct({ title: Schema.String }),
          execute: () => Effect.succeed({ content: "ok" }),
        }),
      ),
    ),
  )
  expect(registered).toHaveLength(1)
  expect(Schema.isSchema(registered[0]?.input)).toBe(false)
})

test("converts schemas authored by the plugin Effect runtime", async () => {
  const prepared = await fixture
  const tool = prepared.instanceSafeTool({
    name: "create",
    description: "Create",
    input: prepared.Schema.FiniteFromString,
    output: prepared.Schema.FiniteFromString,
    execute: () => prepared.Effect.succeed({ output: 42 }),
  })

  expect(Schema.isSchema(tool.input)).toBe(false)
  const input = tool.input as StandardSchemaV1
  expect(await input["~standard"].validate("42")).toEqual({ value: 42 })
  expect(await input["~standard"].validate(42)).toHaveProperty("issues")
  expect((input as StandardJSONSchemaV1)["~standard"].jsonSchema.input({ target: "draft-2020-12" })).toMatchObject({
    type: "string",
  })
  const output = tool.output as StandardSchemaV1 & StandardJSONSchemaV1
  expect(await output["~standard"].validate(42)).toEqual({ value: "42" })
  expect(output["~standard"].jsonSchema.output({ target: "draft-2020-12" })).toMatchObject({ type: "string" })
})

test("rejects an unprepared schema from another Effect runtime", async () => {
  const prepared = await fixture
  expect(() =>
    prepared.instanceSafeTool({
      name: "create",
      description: "Create",
      input: Schema.Struct({ title: Schema.String }),
      execute: () => prepared.Effect.succeed({ content: "ok" }),
    }),
  ).toThrow("must use Schema from @opencode-ai/plugin/effect")
})

test("accepts a foreign schema prepared by its authoring runtime", async () => {
  const prepared = await fixture
  const schema = Schema.Struct({ title: Schema.String })
  const augmented = Schema.toStandardJSONSchemaV1(Schema.toStandardSchemaV1(schema))
  const detached = { "~standard": augmented["~standard"] }
  const tool = prepared.instanceSafeTool({
    name: "create",
    description: "Create",
    input: detached,
    execute: () => prepared.Effect.succeed({ content: "ok" }),
  })

  expect(Schema.isSchema(tool.input)).toBe(false)
  const input = tool.input as StandardSchemaV1 & StandardJSONSchemaV1
  expect(await input["~standard"].validate({ title: "probe" })).toEqual({ value: { title: "probe" } })
  expect(input["~standard"].jsonSchema.input({ target: "draft-2020-12" })).toMatchObject({ type: "object" })
})

test("rejects incomplete Standard Schema implementations", async () => {
  const prepared = await fixture
  expect(() =>
    prepared.instanceSafeTool({
      name: "create",
      description: "Create",
      input: { "~standard": { version: 1, vendor: "test", validate: () => ({ value: {} }) } } as Tool.ValueSchema,
      execute: () => prepared.Effect.succeed({ content: "ok" }),
    }),
  ).toThrow("must implement Standard Schema validation and JSON Schema generation")
})

async function prepareAdapter() {
  const directory = await mkdtemp(path.join(tmpdir(), "opencode-plugin-effect-"))
  const source = path.dirname(fileURLToPath(import.meta.resolve("effect/package.json")))
  await cp(source, path.join(directory, "node_modules", "effect"), { recursive: true })
  await cp(new URL("../src/effect/tool-schema.ts", import.meta.url), path.join(directory, "tool-schema.ts"))
  const adapter = (await import(pathToFileURL(path.join(directory, "tool-schema.ts")).href)) as {
    instanceSafeTool: (tool: Tool.Info) => Tool.Info
  }
  const runtime = (await import(
    pathToFileURL(path.join(directory, "node_modules", "effect", "dist", "index.js")).href
  )) as {
    Effect: typeof Effect
    Schema: typeof Schema
  }
  return { directory, instanceSafeTool: adapter.instanceSafeTool, Effect: runtime.Effect, Schema: runtime.Schema }
}
