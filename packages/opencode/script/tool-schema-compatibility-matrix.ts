import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import type { JSONSchema7 } from "@ai-sdk/provider"
import { Effect } from "effect"
import { jsonSchema, streamText, tool, type LanguageModel } from "ai"
import { AppRuntime } from "@/effect/app-runtime"
import { InstanceRef } from "@/effect/instance-ref"
import { Provider } from "@/provider/provider"
import { InstanceStore } from "@/project/instance-store"
import { MFJS } from "@/provider/mfjs"

// Usage:
// bun run script/tool-schema-compatibility-matrix.ts --models=model-a,model-b
//   [--provider=opencode-go] [--projection=none|mfjs]
//   [--cases=tuple items,...] [--concurrency=9] [--timeout=30000]

type JsonRecord = Record<string, unknown>
type Case = {
  name: string
  schema: JsonRecord
}
type Result = {
  case: string
  model: string
  status: "accepted" | "rejected" | "rate-limited" | "error"
  code?: number
  error?: string
}

const projection = option("projection") ?? "none"
if (projection !== "none" && projection !== "mfjs") throw new Error(`Unsupported projection: ${projection}`)
const concurrency = Number(option("concurrency") ?? 9)
const timeout = Number(option("timeout") ?? 30_000)
const providerID = option("provider") ?? "opencode-go"
const models = option("models")?.split(",").filter(Boolean) ?? []
if (models.length === 0) throw new Error("--models must contain at least one model ID")
const selectedCases = new Set(option("cases")?.split(",").filter(Boolean) ?? [])

const matrix: Case[] = [
  property("enum/type mismatch", { type: "object", enum: ["move", "copy"] }),
  property("untyped enum", { enum: ["move", "copy"] }),
  property("mixed untyped enum", { enum: ["move", 1, null, true] }),
  property("const", { const: "move" }),
  property("tuple items", { type: "array", items: [{ type: "string" }, { type: "number" }] }),
  property("prefix items", { type: "array", prefixItems: [{ type: "string" }, { type: "number" }] }),
  property("typed anyOf", {
    type: "string",
    enum: ["move"],
    anyOf: [{ type: "string" }, { type: "null" }],
  }),
  property("anyOf count limit", {
    anyOf: Array.from({ length: 501 }, (_, index) => ({ const: `value_${index}` })),
  }),
  property("oneOf", { oneOf: [{ type: "string" }, { type: "integer" }] }),
  property("allOf", {
    allOf: [
      { type: "object", properties: { left: { type: "string" } } },
      { type: "object", properties: { right: { type: "number" } } },
    ],
  }),
  property("not", { type: "string", not: { enum: ["blocked"] } }),
  property("if/then/else", {
    type: "object",
    properties: { mode: { type: "string" }, count: { type: "integer" } },
    if: { properties: { mode: { enum: ["many"] } } },
    then: { required: ["count"] },
    else: { properties: { count: { maximum: 1 } } },
  }),
  property("contains", { type: "array", contains: { type: "string" } }),
  objectCase("patternProperties", {
    type: "object",
    patternProperties: { "^extra_": { type: "number" } },
    additionalProperties: false,
  }),
  objectCase("dependentSchemas", {
    type: "object",
    properties: { key: { type: "string" }, value: { type: "string" } },
    dependentSchemas: { key: { required: ["value"] } },
  }),
  objectCase("propertyNames", {
    type: "object",
    propertyNames: { pattern: "^[a-z]+$" },
  }),
  property("uniqueItems", { type: "array", items: { type: "string" }, uniqueItems: true }),
  property("boolean true schema", true),
  property("boolean false schema", false),
  objectCase("empty property name", {
    type: "object",
    properties: { "": { type: "string" } },
    required: [""],
  }),
  objectCase("dangling required", {
    type: "object",
    properties: {},
    required: ["missing"],
  }),
  objectCase("external ref", {
    type: "object",
    properties: { value: { $ref: "https://example.com/schema.json" } },
  }),
  objectCase("chained ref", {
    type: "object",
    properties: { value: { $ref: "#/$defs/A" } },
    $defs: { A: { $ref: "#/$defs/B" }, B: { type: "string" } },
  }),
  objectCase("recursive ref", {
    type: "object",
    properties: { node: { $ref: "#/$defs/Node" } },
    $defs: {
      Node: {
        type: "object",
        properties: { value: { type: "string" }, next: { anyOf: [{ $ref: "#/$defs/Node" }, { type: "null" }] } },
        required: ["value"],
      },
    },
  }),
  objectCase("reference depth limit", {
    type: "object",
    properties: { value: { $ref: "#/$defs/Value" } },
    $defs: { Value: nested(30) },
  }),
  objectCase("schema size limit", {
    type: "object",
    description: "x".repeat(120_001),
    properties: {},
  }),
  objectCase("schema depth limit", nested(35)),
  objectCase("property count limit", {
    type: "object",
    properties: Object.fromEntries(
      Array.from({ length: 3001 }, (_, index) => [`property_${index}`, { type: "string" }]),
    ),
  }),
  property("enum count limit", {
    type: "string",
    enum: Array.from({ length: 1001 }, (_, index) => `value_${index}`),
  }),
]
const cases = selectedCases.size === 0 ? matrix : matrix.filter((item) => selectedCases.has(item.name))

const { store, ctx } = await AppRuntime.runPromise(
  InstanceStore.Service.use((store) =>
    store.load({ directory: process.cwd() }).pipe(Effect.map((ctx) => ({ store, ctx }))),
  ),
)

try {
  const languages = await AppRuntime.runPromise(
    Effect.gen(function* () {
      const provider = yield* Provider.Service
      return yield* Effect.forEach(
        models,
        Effect.fnUntraced(function* (model) {
          const info = yield* provider.getModel(ProviderV2.ID.make(providerID), ModelV2.ID.make(model))
          return [model, yield* provider.getLanguage(info)] as const
        }),
        { concurrency: "unbounded" },
      )
    }).pipe(Effect.provideService(InstanceRef, ctx)),
  )
  const jobs = languages.flatMap(([model, language]) => cases.map((item) => () => run(language, model, item)))
  const results = await parallel(jobs, concurrency)
  print(results)
  if (projection !== "none" && results.some((result) => result.status !== "accepted")) process.exitCode = 1
} finally {
  await AppRuntime.runPromise(store.dispose(ctx))
}
process.exit(process.exitCode ?? 0)

async function run(language: LanguageModel, model: string, item: Case): Promise<Result> {
  const schema = projection === "mfjs" ? MFJS.sanitize(item.schema) : item.schema
  let providerError: unknown
  try {
    const response = streamText({
      model: language,
      prompt: "Reply with exactly OK without calling tools.",
      maxOutputTokens: 16,
      abortSignal: AbortSignal.timeout(timeout),
      onError(event) {
        providerError = event.error
      },
      tools: {
        probe: tool({
          description: `Tool schema probe: ${item.name}`,
          inputSchema: jsonSchema(schema as JSONSchema7),
          execute: async () => "ok",
        }),
      },
    })
    await response.text
    if (providerError) throw providerError
    console.error(`accepted: ${model} / ${item.name}`)
    return { case: item.name, model, status: "accepted" }
  } catch (error) {
    const failure = providerError ?? error
    const code = statusCode(failure)
    const message = failure instanceof Error ? failure.message : String(failure)
    const status = code === 429 || /rate limit/i.test(message) ? "rate-limited" : code === 400 ? "rejected" : "error"
    console.error(`${status}: ${model} / ${item.name}`)
    return {
      case: item.name,
      model,
      status,
      code,
      error: message,
    }
  }
}

async function parallel<T>(jobs: Array<() => Promise<T>>, limit: number) {
  const output = new Array<T>(jobs.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, jobs.length) }, async () => {
      while (true) {
        const index = next++
        const job = jobs[index]
        if (!job) return
        output[index] = await job()
      }
    }),
  )
  return output
}

function print(results: Result[]) {
  const byCase = new Map<string, Map<string, Result>>()
  results.forEach((result) => {
    const row = byCase.get(result.case) ?? new Map<string, Result>()
    row.set(result.model, result)
    byCase.set(result.case, row)
  })
  console.log(`Projection: ${projection}`)
  console.log(`Provider: ${providerID}`)
  console.log(`| Case | ${models.join(" | ")} |`)
  console.log(`| --- | ${models.map(() => "---").join(" | ")} |`)
  cases.forEach((item) => {
    const row = byCase.get(item.name)
    const values = models.map((model) => {
      const result = row?.get(model)
      if (!result) return "missing"
      return result.status === "accepted" ? "accepted" : `${result.status}${result.code ? ` (${result.code})` : ""}`
    })
    console.log(`| ${item.name} | ${values.join(" | ")} |`)
  })
  const rejected = results.filter((result) => result.status !== "accepted")
  if (rejected.length > 0) {
    console.log("\nRejected details:")
    rejected.forEach((result) => console.log(`- ${result.model} / ${result.case}: ${result.error}`))
  }
}

function property(name: string, schema: unknown): Case {
  return objectCase(name, { type: "object", properties: { value: schema }, required: ["value"] })
}

function objectCase(name: string, schema: JsonRecord): Case {
  return { name, schema }
}

function nested(depth: number): JsonRecord {
  return Array.from({ length: depth }).reduce<JsonRecord>(
    (schema) => ({ type: "object", properties: { next: schema }, required: ["next"] }),
    { type: "string" },
  )
}

function option(name: string) {
  const prefix = `--${name}=`
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length)
}

function statusCode(error: unknown, seen = new Set<object>()): number | undefined {
  if (!isRecord(error) || seen.has(error)) return
  seen.add(error)
  if (typeof error.statusCode === "number") return error.statusCode
  for (const value of Object.values(error)) {
    const nested = statusCode(value, seen)
    if (nested !== undefined) return nested
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
