export * as ToolInputRepairPlugin from "./tool-input-repair.js"

import { define } from "@opencode-ai/plugin/effect/plugin"
import { Effect, JsonSchema, Option, Predicate, Schema } from "effect"

// Repairs apply only when the input schema unambiguously supports them:
// - Stringified root or nested object: '{"limit":"20"}' -> { limit: 20 }
// - Closed object: { limit: "20", extra: true } -> { limit: 20 }
// - Optional null or empty-object placeholder: { limit: null } -> {}
// - Numeric or boolean string: { limit: "20", enabled: "false" } -> { limit: 20, enabled: false }
// - Nullable or tagged union: { item: { kind: "count", value: "2" } } -> { item: { kind: "count", value: 2 } }
// - Stringified array or compatible item: { tags: '["a"]', count: "2" } -> { tags: ["a"], count: [2] }
// - Positional tuple: { pair: ["2", "false"] } -> { pair: [2, false] }
// - Typed or patterned dictionary: { counts: { first: "2" } } -> { counts: { first: 2 } }
// - Nested fields and local references: { items: [{ count: "2" }] } -> { items: [{ count: 2 }] }

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))
const maxDepth = 6

export const Plugin = define({
  id: "opencode.tool.input.repair",
  effect: (ctx) =>
    ctx.tool.hook("execute.before", (event) =>
      Effect.sync(() => {
        const schema = event.inputSchema
        if (
          schema.type !== "object" &&
          !hasObjectShape(schema) &&
          !["$ref", "anyOf", "oneOf", "allOf"].some((key) => key in schema)
        )
          return
        event.input = repair(event.input, schema, schema, 0)
      }),
    ),
})

function repair(value: unknown, schema: JsonSchema.JsonSchema, root: JsonSchema.JsonSchema, depth: number): unknown {
  if (depth > maxDepth) return value

  if (typeof schema.$ref === "string") {
    const modern = schema.$ref.startsWith("#/$defs/")
    const legacy = schema.$ref.startsWith("#/definitions/")
    const definitions = modern ? root.$defs : legacy ? root.definitions : undefined
    if (!Predicate.isObject(definitions)) return value
    const entries = Object.entries(definitions).filter((entry): entry is [string, JsonSchema.JsonSchema] =>
      Predicate.isObject(entry[1]),
    )
    const target = JsonSchema.resolve$ref(schema.$ref, Object.fromEntries(entries))
    if (!target) return value
    const siblings = Object.fromEntries(Object.entries(schema).filter(([key]) => key !== "$ref"))
    const repaired = repair(value, target, root, depth + 1)
    return Object.keys(siblings).length > 0 ? repair(repaired, siblings, root, depth + 1) : repaired
  }

  if (Array.isArray(schema.type)) {
    return repairUnion(
      value,
      schema.type.map((type) => ({ ...schema, type })),
      root,
      depth,
    )
  }
  if (schema.type === undefined && Array.isArray(schema.anyOf) && Array.isArray(schema.oneOf)) {
    const alternatives = schema.oneOf
    const shared = schema.anyOf.filter(
      (branch) =>
        Predicate.isObject(branch) &&
        typeof branch.type === "string" &&
        alternatives.some((member) => Predicate.isObject(member) && member.type === branch.type),
    )
    if (shared.length === 1) return repair(value, { ...schema, type: shared[0]?.type }, root, depth + 1)
  }

  const base = repairType(value, schema, root, depth)

  const any = Array.isArray(schema.anyOf) ? repairUnion(base, schema.anyOf, root, depth) : base
  const selected = Array.isArray(schema.oneOf) ? repairUnion(any, schema.oneOf, root, depth) : any
  if (!Array.isArray(schema.allOf)) return selected

  return schema.allOf.reduce<unknown>((current, member) => {
    if (!Predicate.isObject(member)) return current
    const safe = member.additionalProperties === false ? { ...member, additionalProperties: true } : member
    return repair(current, safe, root, depth + 1)
  }, selected)
}

function repairType(
  value: unknown,
  schema: JsonSchema.JsonSchema,
  root: JsonSchema.JsonSchema,
  depth: number,
): unknown {
  switch (schema.type) {
    case "number":
    case "integer":
      return repairNumber(value, schema.type === "integer")
    case "boolean":
      if (value === "true") return true
      if (value === "false") return false
      return value
    case "array":
      return repairArray(value, schema, root, depth)
    case "object":
      return repairObject(value, schema, root, depth)
    default:
      return hasObjectShape(schema) ? repairObject(value, schema, root, depth) : value
  }
}

function repairUnion(value: unknown, alternatives: unknown[], root: JsonSchema.JsonSchema, depth: number): unknown {
  if (
    alternatives.some((branch) => branch === true || (Predicate.isObject(branch) && Object.keys(branch).length === 0))
  ) {
    return value
  }

  const branches = alternatives.filter(Predicate.isObject)
  if (branches.some((branch) => "const" in branch || Array.isArray(branch.enum))) return value

  if (value === null) return value
  if (typeof value === "string" && branches.some((branch) => branch.type === "string")) return value
  if (typeof value === "boolean" && branches.some((branch) => branch.type === "boolean")) return value
  if (typeof value === "number" && branches.some((branch) => branch.type === "number" || branch.type === "integer")) {
    return value
  }

  const candidates = branches.filter((branch) => {
    if (!Predicate.isObject(value)) return branch.type !== "null"
    const members = Array.isArray(branch.allOf) ? branch.allOf.filter(Predicate.isObject) : [branch]
    return members.every((member) => {
      if (Array.isArray(member.required) && !member.required.every((key) => Object.hasOwn(value, key))) return false
      const properties = Predicate.isObject(member.properties) ? member.properties : {}
      if (member.additionalProperties === false && Object.keys(properties).length > 0) {
        if (!Object.keys(value).some((key) => Object.hasOwn(properties, key))) return false
      }
      return Object.entries(properties).every(([key, property]) => {
        if (!Object.hasOwn(value, key) || !Predicate.isObject(property)) return true
        if ("const" in property) return value[key] === property.const
        return !Array.isArray(property.enum) || property.enum.includes(value[key])
      })
    })
  })

  const candidate = candidates[0]
  if (candidates.length === 1 && candidate) return repair(value, candidate, root, depth + 1)
  if (
    candidates.length > 1 &&
    candidates.every((branch) => branch.type === "number" || branch.type === "integer") &&
    candidates.some((branch) => Object.keys(branch).some((key) => key !== "type"))
  ) {
    return repairNumber(
      value,
      candidates.every((branch) => branch.type === "integer"),
    )
  }

  return value
}

function repairObject(
  value: unknown,
  schema: JsonSchema.JsonSchema,
  root: JsonSchema.JsonSchema,
  depth: number,
): unknown {
  const parsed = typeof value === "string" ? Option.getOrUndefined(decodeJson(value)) : value
  if (!Predicate.isObject(parsed)) return value

  const properties = Predicate.isObject(schema.properties) ? schema.properties : {}
  const patterns = Predicate.isObject(schema.patternProperties) ? schema.patternProperties : {}
  const required = Array.isArray(schema.required) ? schema.required : []

  return Object.keys(parsed).reduce<Record<string, unknown>>((result, key) => {
    const current = result[key]
    const declared = Object.hasOwn(properties, key)
    const property = declared ? properties[key] : undefined
    const matching = Object.entries(patterns)
      .filter(([pattern]) => new RegExp(pattern).test(key))
      .map(([, member]) => member)
      .filter(Predicate.isObject)

    if (!declared && matching.length === 0 && schema.additionalProperties === false && !Array.isArray(schema.allOf)) {
      const next = { ...result }
      delete next[key]
      return next
    }

    if (declared && Predicate.isObject(property) && !required.includes(key)) {
      const alternatives = [
        ...(Array.isArray(property.anyOf) ? property.anyOf : []),
        ...(Array.isArray(property.oneOf) ? property.oneOf : []),
      ]
      const nullable =
        property.type === "null" ||
        (Array.isArray(property.type) && property.type.includes("null")) ||
        (property.nullable === true && alternatives.length === 0) ||
        alternatives.some((branch) => Predicate.isObject(branch) && branch.type === "null")
      const placeholder =
        Predicate.isObject(current) &&
        Object.keys(current).length === 0 &&
        typeof property.type === "string" &&
        property.type !== "object" &&
        alternatives.length === 0
      if ((current === null && !nullable && (property.type !== undefined || alternatives.length > 0)) || placeholder) {
        const next = { ...result }
        delete next[key]
        return next
      }
    }

    const owners =
      declared && Predicate.isObject(property)
        ? [property, ...matching]
        : matching.length > 0
          ? matching
          : !declared && Predicate.isObject(schema.additionalProperties) && !Array.isArray(schema.allOf)
            ? [schema.additionalProperties]
            : []
    const owner = owners[0]
    if (owners.length !== 1 || !owner) return result
    const repaired = repair(current, owner, root, depth + 1)
    return repaired === current ? result : { ...result, [key]: repaired }
  }, parsed)
}

function repairArray(
  value: unknown,
  schema: JsonSchema.JsonSchema,
  root: JsonSchema.JsonSchema,
  depth: number,
): unknown {
  const tuple = Array.isArray(schema.prefixItems)
    ? schema.prefixItems
    : Array.isArray(schema.items)
      ? schema.items
      : undefined
  const parsed = typeof value === "string" ? Option.getOrUndefined(decodeJson(value)) : value

  if (Array.isArray(parsed)) {
    const repaired = parsed.map((item, index) => {
      const member = tuple
        ? (tuple[index] ?? (Array.isArray(schema.prefixItems) ? schema.items : schema.additionalItems))
        : schema.items
      return Predicate.isObject(member) ? repair(item, member, root, depth + 1) : item
    })
    return repaired.every((item, index) => item === parsed[index]) ? parsed : repaired
  }

  if (tuple || !Predicate.isObject(schema.items)) return value
  const repaired = repair(value, schema.items, root, depth + 1)
  const type = schema.items.type
  const compatible =
    type === "object"
      ? Predicate.isObject(repaired)
      : type === "array"
        ? Array.isArray(repaired)
        : type === "integer"
          ? typeof repaired === "number" && Number.isSafeInteger(repaired)
          : type === "number"
            ? typeof repaired === "number" && Number.isFinite(repaired)
            : (type === "string" || type === "boolean") && typeof repaired === type
  return compatible ? [repaired] : value
}

function repairNumber(value: unknown, integer: boolean): unknown {
  if (typeof value !== "string" || value.trim() === "") return value
  const parsed = Number(value)
  return Number.isFinite(parsed) && (!integer || Number.isSafeInteger(parsed)) ? parsed : value
}

function hasObjectShape(schema: JsonSchema.JsonSchema): boolean {
  return (
    Predicate.isObject(schema.properties) ||
    Array.isArray(schema.required) ||
    Predicate.isObject(schema.patternProperties) ||
    "additionalProperties" in schema
  )
}
