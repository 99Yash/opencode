export * as ToolInputRepairPlugin from "./tool-input-repair.js"

import { define } from "@opencode-ai/plugin/effect/plugin"
import { Effect, JsonPointer, Option, Predicate, Schema } from "effect"
import type { JsonSchema } from "effect"

// Repairs apply only when the input schema unambiguously supports them:
// - Stringified root or nested object: '{"limit":"20"}' -> { limit: 20 }
// - Closed object: { limit: "20", extra: true } -> { limit: 20 }
// - Optional non-nullable null or non-object placeholder: { limit: null } -> {}
// - Numeric or boolean string: { limit: "20", enabled: "false" } -> { limit: 20, enabled: false }
// - Constrained or nullable union: { limit: "20" } -> { limit: 20 }
// - Tagged union or intersection: { item: { kind: "count", value: "2" } } -> { item: { kind: "count", value: 2 } }
// - Stringified array or compatible item: { tags: '["a"]', count: "2" } -> { tags: ["a"], count: [2] }
// - Positional or rest tuple: { pair: ["2", "false"] } -> { pair: [2, false] }
// - Typed, patterned, or referenced dictionary: { counts: { first: "2" } } -> { counts: { first: 2 } }
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
          !Predicate.isObject(schema.properties) &&
          !Array.isArray(schema.required) &&
          !Predicate.isObject(schema.patternProperties) &&
          !("additionalProperties" in schema) &&
          !("anyOf" in schema) &&
          !("oneOf" in schema) &&
          !("allOf" in schema) &&
          !("$ref" in schema)
        ) {
          return
        }
        event.input = repair(event.input, schema, schema, 0)
      }),
    ),
})

function repair(value: unknown, schema: JsonSchema.JsonSchema, root: JsonSchema.JsonSchema, depth: number): unknown {
  if (depth > maxDepth) return value

  if (typeof schema.$ref === "string") {
    const target = resolveReference(schema.$ref, root)
    if (!target) return value
    const siblings = Object.fromEntries(Object.entries(schema).filter(([key]) => key !== "$ref"))
    const referenced = repair(value, target, root, depth + 1)
    return Object.keys(siblings).length === 0 ? referenced : repair(referenced, siblings, root, depth + 1)
  }

  const alternatives = Array.isArray(schema.type)
    ? schema.type.map((type) => ({ ...schema, type, anyOf: undefined, oneOf: undefined }))
    : undefined
  const hasComposition = Array.isArray(schema.anyOf) || Array.isArray(schema.oneOf)
  const base = alternatives
    ? repairUnion(value, alternatives, schema, root, depth)
    : hasComposition && typeof schema.type !== "string" && !hasObjectShape(schema)
      ? value
      : repairType(value, schema, root, depth)

  const any = Array.isArray(schema.anyOf) ? repairUnion(base, schema.anyOf, schema, root, depth) : base
  const selected = Array.isArray(schema.oneOf) ? repairUnion(any, schema.oneOf, schema, root, depth) : any
  if (!Array.isArray(schema.allOf)) return selected
  const intersections = schema.allOf

  return intersections.reduce<unknown>((result, member) => {
    if (!Predicate.isObject(member)) return result
    // Intersections cannot safely assign undeclared keys to one closed member.
    const intersection =
      Predicate.isObject(result) &&
      member.additionalProperties === false &&
      (intersections.length > 1 || hasObjectShape(schema))
        ? { ...member, additionalProperties: true }
        : member
    return repair(result, intersection, root, depth + 1)
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
      return repairBoolean(value)
    case "object":
      return repairObject(value, schema, root, depth)
    case "array":
      return repairArray(value, schema, root, depth)
    default:
      return hasObjectShape(schema) ? repairObject(value, schema, root, depth) : value
  }
}

function repairUnion(
  value: unknown,
  alternatives: unknown[],
  parent: JsonSchema.JsonSchema,
  root: JsonSchema.JsonSchema,
  depth: number,
): unknown {
  const branches = alternatives.filter(
    (branch): branch is JsonSchema.JsonSchema | boolean => Predicate.isObject(branch) || typeof branch === "boolean",
  )
  const matching = branches.filter((branch) => matchesSchema(value, branch, root, depth + 1))
  if (matching.length > 0) return value

  const candidates = branches
    .filter(Predicate.isObject)
    .filter((branch) => !Predicate.isObject(value) || ownsClosedProperties(value, branch, root, depth + 1))
    .map((branch) => ({ branch, value: repair(value, branch, root, depth + 1) }))
    .filter((candidate) => matchesSchema(candidate.value, candidate.branch, root, depth + 1))
    .filter((candidate) => matchesSiblingConstraints(candidate.value, parent, root, depth + 1))
  const candidate = candidates[0]
  if (candidates.length !== 1 || !candidate) return value
  if (branches.filter((branch) => matchesSchema(candidate.value, branch, root, depth + 1)).length !== 1) return value
  return candidate.value
}

function ownsClosedProperties(
  value: Record<string, unknown>,
  schema: JsonSchema.JsonSchema,
  root: JsonSchema.JsonSchema,
  depth: number,
): boolean {
  if (depth > maxDepth) return false
  if (typeof schema.$ref === "string") {
    const target = resolveReference(schema.$ref, root)
    if (!target || !ownsClosedProperties(value, target, root, depth + 1)) return false
  }
  if (
    Array.isArray(schema.allOf) &&
    !schema.allOf.every((member) => !Predicate.isObject(member) || ownsClosedProperties(value, member, root, depth + 1))
  ) {
    return false
  }
  if (schema.additionalProperties !== false) return true

  const properties = Predicate.isObject(schema.properties) ? schema.properties : {}
  const patterns = Predicate.isObject(schema.patternProperties) ? schema.patternProperties : {}
  if (Object.keys(properties).length === 0 && Object.keys(patterns).length === 0) return true
  return Object.keys(value).some(
    (key) => Object.hasOwn(properties, key) || Object.keys(patterns).some((pattern) => new RegExp(pattern).test(key)),
  )
}

function matchesSiblingConstraints(
  value: unknown,
  schema: JsonSchema.JsonSchema,
  root: JsonSchema.JsonSchema,
  depth: number,
): boolean {
  const siblings = Object.fromEntries(
    Object.entries(schema).filter(([key]) => key !== "anyOf" && key !== "oneOf" && key !== "allOf"),
  )
  return matchesSchema(value, siblings, root, depth)
}

function matchesSchema(
  value: unknown,
  schema: JsonSchema.JsonSchema | boolean,
  root: JsonSchema.JsonSchema,
  depth: number,
): boolean {
  if (typeof schema === "boolean") return schema
  if (depth > maxDepth) return false

  if (typeof schema.$ref === "string") {
    const target = resolveReference(schema.$ref, root)
    if (!target || !matchesSchema(value, target, root, depth + 1)) return false
  }
  if ("const" in schema && !equalsJson(value, schema.const)) return false
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => equalsJson(value, item))) return false

  if (!(schema.nullable === true && value === null)) {
    if (Array.isArray(schema.type)) {
      if (!schema.type.some((type) => matchesType(value, type))) return false
    } else if (typeof schema.type === "string" && !matchesType(value, schema.type)) {
      return false
    }
  }

  if (typeof value === "number" && !matchesNumber(value, schema)) return false
  if (typeof value === "string" && !matchesString(value, schema)) return false
  if (Predicate.isObject(value) && !matchesObject(value, schema, root, depth)) return false
  if (Array.isArray(value) && !matchesArray(value, schema, root, depth)) return false
  if (Array.isArray(schema.allOf) && !schema.allOf.every((member) => matchesMember(value, member, root, depth + 1))) {
    return false
  }
  if (Array.isArray(schema.anyOf) && !schema.anyOf.some((member) => matchesMember(value, member, root, depth + 1))) {
    return false
  }
  if (
    Array.isArray(schema.oneOf) &&
    schema.oneOf.filter((member) => matchesMember(value, member, root, depth + 1)).length !== 1
  ) {
    return false
  }
  return true
}

function matchesMember(value: unknown, member: unknown, root: JsonSchema.JsonSchema, depth: number): boolean {
  return (Predicate.isObject(member) || typeof member === "boolean") && matchesSchema(value, member, root, depth)
}

function matchesType(value: unknown, type: unknown): boolean {
  if (type === "null") return value === null
  if (type === "object") return Predicate.isObject(value)
  if (type === "array") return Array.isArray(value)
  if (type === "integer") return typeof value === "number" && Number.isSafeInteger(value)
  if (type === "number") return typeof value === "number" && Number.isFinite(value)
  return (type === "string" || type === "boolean") && typeof value === type
}

function matchesNumber(value: number, schema: JsonSchema.JsonSchema): boolean {
  if (typeof schema.minimum === "number" && value < schema.minimum) return false
  if (typeof schema.maximum === "number" && value > schema.maximum) return false
  if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum) return false
  if (typeof schema.exclusiveMaximum === "number" && value >= schema.exclusiveMaximum) return false
  if (schema.exclusiveMinimum === true && typeof schema.minimum === "number" && value <= schema.minimum) return false
  if (schema.exclusiveMaximum === true && typeof schema.maximum === "number" && value >= schema.maximum) return false
  return typeof schema.multipleOf !== "number" || value / schema.multipleOf === Math.round(value / schema.multipleOf)
}

function matchesString(value: string, schema: JsonSchema.JsonSchema): boolean {
  if (typeof schema.minLength === "number" && value.length < schema.minLength) return false
  if (typeof schema.maxLength === "number" && value.length > schema.maxLength) return false
  return typeof schema.pattern !== "string" || new RegExp(schema.pattern).test(value)
}

function matchesObject(
  value: Record<string, unknown>,
  schema: JsonSchema.JsonSchema,
  root: JsonSchema.JsonSchema,
  depth: number,
): boolean {
  if (
    Array.isArray(schema.required) &&
    !schema.required.every((key) => typeof key === "string" && Object.hasOwn(value, key))
  ) {
    return false
  }
  if (typeof schema.minProperties === "number" && Object.keys(value).length < schema.minProperties) return false
  if (typeof schema.maxProperties === "number" && Object.keys(value).length > schema.maxProperties) return false

  const properties = Predicate.isObject(schema.properties) ? schema.properties : {}
  const patterns = Predicate.isObject(schema.patternProperties) ? schema.patternProperties : {}
  return Object.entries(value).every(([key, current]) => {
    const property = properties[key]
    if (Object.hasOwn(properties, key) && !matchesMember(current, property, root, depth + 1)) return false
    const matching = Object.entries(patterns).filter(([pattern]) => new RegExp(pattern).test(key))
    if (!matching.every(([, member]) => matchesMember(current, member, root, depth + 1))) return false
    if (Object.hasOwn(properties, key) || matching.length > 0) return true
    if (schema.additionalProperties === false) return false
    return (
      !Predicate.isObject(schema.additionalProperties) ||
      matchesSchema(current, schema.additionalProperties, root, depth + 1)
    )
  })
}

function matchesArray(
  value: unknown[],
  schema: JsonSchema.JsonSchema,
  root: JsonSchema.JsonSchema,
  depth: number,
): boolean {
  if (typeof schema.minItems === "number" && value.length < schema.minItems) return false
  if (typeof schema.maxItems === "number" && value.length > schema.maxItems) return false
  const tuple = Array.isArray(schema.prefixItems)
    ? schema.prefixItems
    : Array.isArray(schema.items)
      ? schema.items
      : undefined
  return value.every((item, index) => {
    const member = tuple
      ? (tuple[index] ?? (Array.isArray(schema.prefixItems) ? schema.items : schema.additionalItems))
      : schema.items
    if (member === undefined) return true
    return matchesMember(item, member, root, depth + 1)
  })
}

function equalsJson(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => equalsJson(value, right[index]))
  }
  if (!Predicate.isObject(left) || !Predicate.isObject(right)) return false
  const keys = Object.keys(left)
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => Object.hasOwn(right, key) && equalsJson(left[key], right[key]))
  )
}

function resolveReference(reference: string, root: JsonSchema.JsonSchema): JsonSchema.JsonSchema | undefined {
  if (!reference.startsWith("#/$defs/") && !reference.startsWith("#/definitions/")) return undefined
  const target = reference
    .slice(2)
    .split("/")
    .map(JsonPointer.unescapeToken)
    .reduce<unknown>(
      (current, segment) =>
        Predicate.isObject(current) && Object.hasOwn(current, segment) ? current[segment] : undefined,
      root,
    )
  return Predicate.isObject(target) ? target : undefined
}

function hasObjectShape(schema: JsonSchema.JsonSchema): boolean {
  return (
    Predicate.isObject(schema.properties) ||
    Array.isArray(schema.required) ||
    Predicate.isObject(schema.patternProperties) ||
    "additionalProperties" in schema
  )
}

function repairNumber(value: unknown, integer: boolean): unknown {
  if (typeof value !== "string" || value.trim() === "") return value
  const number = Number(value)
  if (!Number.isFinite(number) || (integer && !Number.isSafeInteger(number))) return value
  return number
}

function repairBoolean(value: unknown): unknown {
  if (value === "true") return true
  if (value === "false") return false
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
      .filter(
        (member): member is JsonSchema.JsonSchema | boolean =>
          Predicate.isObject(member) || typeof member === "boolean",
      )

    if (!declared && matching.length === 0 && schema.additionalProperties === false && !Array.isArray(schema.allOf)) {
      const next = { ...result }
      delete next[key]
      return next
    }

    if (declared && Predicate.isObject(property)) {
      if (current === null && !required.includes(key) && !matchesSchema(null, property, root, depth + 1)) {
        const next = { ...result }
        delete next[key]
        return next
      }
      if (
        Predicate.isObject(current) &&
        Object.keys(current).length === 0 &&
        !required.includes(key) &&
        typeof property.type === "string" &&
        property.type !== "object" &&
        !("anyOf" in property) &&
        !("oneOf" in property)
      ) {
        const next = { ...result }
        delete next[key]
        return next
      }
    }

    const owners =
      declared && Predicate.isObject(property)
        ? [property, ...matching.filter(Predicate.isObject)]
        : matching.length > 0
          ? matching.filter(Predicate.isObject)
          : !declared && Predicate.isObject(schema.additionalProperties) && !Array.isArray(schema.allOf)
            ? [schema.additionalProperties]
            : []
    if (owners.length === 0) return result
    if (owners.length > 1 && owners.some((owner) => !equalsJson(owner, owners[0]))) return result
    const repaired = owners.map((owner) => repair(current, owner, root, depth + 1))
    if (repaired.some((next) => !equalsJson(next, repaired[0]))) return result
    const next = repaired[0]
    return next === current ? result : { ...result, [key]: next }
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
  const items = Predicate.isObject(schema.items) ? schema.items : undefined
  const parsed = typeof value === "string" ? Option.getOrUndefined(decodeJson(value)) : value
  if (Array.isArray(parsed)) {
    const repaired = parsed.map((item, index) => {
      const member = tuple
        ? (tuple[index] ?? (Array.isArray(schema.prefixItems) ? schema.items : schema.additionalItems))
        : items
      return Predicate.isObject(member) ? repair(item, member, root, depth + 1) : item
    })
    return repaired.every((item, index) => item === parsed[index]) ? parsed : repaired
  }
  if (tuple || !items) return value

  const item = repair(value, items, root, depth + 1)
  return matchesSchema(item, items, root, depth + 1) ? [item] : value
}
