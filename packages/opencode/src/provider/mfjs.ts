export * as MFJS from "./mfjs"

import type { JSONSchema7 } from "@ai-sdk/provider"

/**
 * Kimi tool-schema compatibility projection.
 *
 * Principles:
 * - Preserve schema features accepted by Kimi without rewriting them.
 * - Apply model-agnostic adaptations only for reproduced provider rejections.
 * - Keep explicit types authoritative; lossy fallbacks may widen but never narrow.
 * - Leave the original tool schema as the execution-time validation authority.
 *
 * Adapted families include enum/type conflicts, untyped enums, tuple `items`,
 * typed `anyOf`, boolean schemas, dangling `required`, references, and observed
 * enum/union/property/size/depth limits. Accepted keywords such as `const`,
 * `oneOf`, `allOf`, conditionals, `prefixItems`, and other constraints pass
 * through recursively.
 *
 * `script/tool-schema-compatibility-matrix.ts` compares raw and MFJS-projected
 * schemas across configured providers and models. Keep this projection
 * evidence-driven as provider behavior evolves.
 *
 * MFJS specification and reference implementation:
 * https://github.com/MoonshotAI/walle
 */

type JsonRecord = Record<string, unknown>
type Context = {
  root: JsonRecord
  definitions: JsonRecord
  properties: number
}

const TYPES = new Set(["string", "number", "boolean", "integer", "object", "array", "null"])
const SCHEMA_MAPS = new Set(["patternProperties", "dependentSchemas"])
const SCHEMA_NODES = new Set([
  "additionalProperties",
  "not",
  "if",
  "then",
  "else",
  "contains",
  "propertyNames",
  "unevaluatedProperties",
])
const SCHEMA_LISTS = new Set(["oneOf", "allOf", "prefixItems"])
const MAX_ANY_OF = 500
const MAX_DEPTH = 30
const MAX_ENUM = 1000
const MAX_PROPERTIES = 3000
const MAX_SCHEMA_SIZE = 120_000

/**
 * Projects tool schemas only where Kimi rejects otherwise valid requests.
 * Accepted keywords are preserved, explicit types remain authoritative, and
 * lossy fallbacks only widen what the model may emit.
 */
export function sanitize(value: unknown): JSONSchema7 {
  const root = isRecord(value) ? value : {}
  const context = { root, definitions: definitions(root), properties: 0 }
  const projected = project(root, context, 0)
  const defs = Object.fromEntries(
    Object.entries(context.definitions)
      .filter(([name, schema]) => name.length > 0 && !name.includes("/") && isRecord(schema))
      .map(([name, schema]) => [name, project(schema, context, 0)]),
  )
  if (Object.keys(defs).length > 0) projected.$defs = defs
  const bounded =
    schemaDepth(projected, projected, new Set()) > MAX_DEPTH ? { type: "object", properties: {} } : projected
  return fitSize(bounded) as JSONSchema7
}

function project(value: unknown, context: Context, depth: number): JsonRecord {
  if (depth >= MAX_DEPTH) return {}
  if (value === true || value === false || !isRecord(value) || Object.keys(value).length === 0) return {}

  const ref = canonicalRef(value.$ref, context)
  if (ref) {
    if (value.nullable === true) return { anyOf: [{ $ref: ref }, { type: "null" }] }
    return { $ref: ref }
  }

  if (Array.isArray(value.anyOf) && schemaTypes(value.type).length > 0) {
    return projectTypedAnyOf(value, context, depth)
  }

  const result: JsonRecord = {}
  let truncatedProperties = false
  for (const [key, item] of Object.entries(value)) {
    if (key === "$defs" || key === "definitions") continue
    if (key === "$ref") continue
    if (key === "items" && Array.isArray(item)) continue
    if (key === "anyOf" && Array.isArray(item)) {
      if (item.length <= MAX_ANY_OF) result.anyOf = item.map((branch) => project(branch, context, depth + 1))
      continue
    }
    if (SCHEMA_LISTS.has(key) && Array.isArray(item)) {
      result[key] = item.map((schema) => project(schema, context, depth + 1))
      continue
    }
    if (key === "properties" && isRecord(item)) {
      const remaining = Math.max(0, MAX_PROPERTIES - context.properties)
      const entries = Object.entries(item).slice(0, remaining)
      context.properties += entries.length
      truncatedProperties = entries.length !== Object.keys(item).length
      result.properties = Object.fromEntries(
        entries.map(([name, schema]) => [name, project(schema, context, depth + 1)]),
      )
      continue
    }
    if (SCHEMA_MAPS.has(key) && isRecord(item)) {
      result[key] = Object.fromEntries(
        Object.entries(item).map(([name, schema]) => [name, project(schema, context, depth + 1)]),
      )
      continue
    }
    if ((key === "items" || SCHEMA_NODES.has(key)) && isRecord(item)) {
      result[key] = project(item, context, depth + 1)
      continue
    }
    result[key] = item
  }
  projectRequired(result, context)
  if (truncatedProperties) delete result.additionalProperties
  return projectEnum(result)
}

function projectTypedAnyOf(source: JsonRecord, context: Context, depth: number) {
  const base = omit(source, ["anyOf", "type", "enum", "const", "$defs", "definitions"])
  const parentTypes = schemaTypes(source.type)
  const parentEnum = enumValues("const" in source ? [source.const] : source.enum)
  const variants = Array.isArray(source.anyOf) ? source.anyOf : []
  if (variants.length > MAX_ANY_OF) return project(omit(source, ["anyOf"]), context, depth)
  const branches = variants.filter(isRecord).flatMap((branch) => {
    const types = intersectTypes(parentTypes, schemaTypes(branch.type))
    if (types.length === 0) return []
    const branchEnum = enumValues("const" in branch ? [branch.const] : branch.enum)
    const values = intersectEnums(parentEnum, branchEnum).filter((value) =>
      types.some((type) => matchesType(value, type)),
    )
    if ((parentEnum.length > 0 || branchEnum.length > 0) && values.length === 0) return []
    const merged = omit({ ...base, ...branch }, ["type", "enum", "const"])
    return [
      project(
        {
          ...merged,
          type: types.length === 1 ? types[0] : types,
          ...(values.length > 0 ? { enum: values } : {}),
        },
        context,
        depth + 1,
      ),
    ]
  })
  return collapse(branches)
}

function projectEnum(source: JsonRecord) {
  const result = { ...source }
  const values = enumValues(result.enum)
  if (values.length === 0) {
    delete result.enum
    return result
  }

  const types = schemaTypes(result.type)
  if (types.length > 0) {
    const compatible = values.filter((value) => types.some((type) => matchesType(value, type)))
    if (compatible.length > 0) result.enum = compatible
    else delete result.enum
    return result
  }

  const groups = groupEnum(values)
  if (groups.length === 1) {
    result.type = groups[0]?.type
    result.enum = groups[0]?.values
    return result
  }
  const base = omit(result, ["enum", "type"])
  return {
    anyOf: groups.map((group) => ({ ...base, type: group.type, enum: group.values })),
  }
}

function projectRequired(schema: JsonRecord, context: Context) {
  if (schema.type !== "object" || !Array.isArray(schema.required)) return
  const properties = isRecord(schema.properties) ? { ...schema.properties } : {}
  const required = [...new Set(schema.required.filter((item): item is string => typeof item === "string"))].filter(
    (name) => {
      if (Object.hasOwn(properties, name)) return true
      if (context.properties >= MAX_PROPERTIES) return false
      context.properties++
      properties[name] = {}
      return true
    },
  )
  schema.properties = properties
  schema.required = required
}

function fitSize(schema: JsonRecord) {
  if (schemaSize(schema) <= MAX_SCHEMA_SIZE) return schema
  const compact = stripAnnotations(schema)
  if (schemaSize(compact) <= MAX_SCHEMA_SIZE) return compact
  return { type: "object", properties: {} }
}

function stripAnnotations(schema: JsonRecord): JsonRecord {
  return Object.fromEntries(
    Object.entries(schema).flatMap(([key, value]) => {
      if (["description", "title", "default", "examples", "$comment"].includes(key)) return []
      if ((key === "properties" || key === "$defs") && isRecord(value)) {
        return [
          [
            key,
            Object.fromEntries(
              Object.entries(value).map(([name, item]) => [name, isRecord(item) ? stripAnnotations(item) : item]),
            ),
          ],
        ]
      }
      if (Array.isArray(value)) {
        return [[key, value.map((item) => (isRecord(item) ? stripAnnotations(item) : item))]]
      }
      return [[key, isRecord(value) ? stripAnnotations(value) : value]]
    }),
  )
}

function schemaSize(schema: JsonRecord) {
  const json = JSON.stringify(schema).replace(/[<>&\u2028\u2029]/g, (char) => {
    return `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`
  })
  return new TextEncoder().encode(json).byteLength
}

function schemaDepth(schema: JsonRecord, root: JsonRecord, refs: Set<string>): number {
  const properties = isRecord(schema.properties)
    ? Math.max(
        0,
        ...Object.values(schema.properties).map((item) => (isRecord(item) ? 1 + schemaDepth(item, root, refs) : 0)),
      )
    : 0
  const nodes = [schema.items, schema.additionalProperties].flatMap((item) =>
    isRecord(item) ? [schemaDepth(item, root, refs)] : [],
  )
  const lists = [schema.anyOf, schema.oneOf, schema.allOf, schema.prefixItems].flatMap((items) =>
    Array.isArray(items) ? items.flatMap((item) => (isRecord(item) ? [schemaDepth(item, root, refs)] : [])) : [],
  )
  const definitions = isRecord(schema.$defs)
    ? Object.values(schema.$defs).flatMap((item) => (isRecord(item) ? [schemaDepth(item, root, refs)] : []))
    : []
  const ref = (() => {
    if (typeof schema.$ref !== "string" || refs.has(schema.$ref)) return 0
    const target = resolveOutputRef(schema.$ref, root)
    if (!target) return 0
    const next = new Set(refs)
    next.add(schema.$ref)
    return schemaDepth(target, root, next)
  })()
  return Math.max(properties, ...nodes, ...lists, ...definitions, ref)
}

function resolveOutputRef(ref: string, root: JsonRecord): JsonRecord | undefined {
  if (ref === "#") return root
  const defs = isRecord(root.$defs) ? root.$defs : undefined
  if (!ref.startsWith("#/$defs/") || !defs) return
  return ref
    .slice("#/$defs/".length)
    .split("/")
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
    .reduce<JsonRecord | undefined>((current, part, index) => {
      const value = index === 0 ? defs[part] : current?.[part]
      return isRecord(value) ? value : undefined
    }, undefined)
}

function canonicalRef(value: unknown, context: Context) {
  if (typeof value !== "string") return
  const ref = value.replace("#/definitions/", "#/$defs/")
  if (ref === "#") return ref
  if (!ref.startsWith("#/$defs/") || ref === "#/$defs/") return
  const name = ref.slice("#/$defs/".length).split("/", 1)[0]?.replaceAll("~1", "/").replaceAll("~0", "~")
  if (!name || name.includes("/")) return
  return isRecord(resolveRef(ref, context)) ? ref : undefined
}

function resolveRef(ref: string, context: Context): unknown {
  if (ref === "#") return context.root
  return ref
    .slice("#/$defs/".length)
    .split("/")
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
    .reduce<unknown>((current, part, index) => {
      if (index === 0) return context.definitions[part]
      return isRecord(current) ? current[part] : undefined
    }, undefined)
}

function definitions(root: JsonRecord) {
  return {
    ...(isRecord(root.definitions) ? root.definitions : {}),
    ...(isRecord(root.$defs) ? root.$defs : {}),
  }
}

function schemaTypes(value: unknown) {
  if (typeof value === "string" && TYPES.has(value)) return [value]
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((item): item is string => typeof item === "string" && TYPES.has(item)))]
}

function intersectTypes(parent: string[], child: string[]) {
  if (child.length === 0) return parent
  return [
    ...new Set([
      ...parent.filter((type) => child.includes(type)),
      ...((parent.includes("number") && child.includes("integer")) ||
      (parent.includes("integer") && child.includes("number"))
        ? ["integer"]
        : []),
    ]),
  ]
}

function enumValues(value: unknown) {
  if (!Array.isArray(value)) return []
  const values = unique(value.filter((item) => valueType(item) !== undefined))
  return values.length > MAX_ENUM ? [] : values
}

function intersectEnums(parent: unknown[], child: unknown[]) {
  if (parent.length === 0) return child
  if (child.length === 0) return parent
  return parent.filter((value) => child.some((item) => Object.is(value, item)))
}

function groupEnum(values: unknown[]) {
  const hasDecimal = values.some((item) => typeof item === "number" && !Number.isInteger(item))
  return values.reduce<{ type: string; values: unknown[] }[]>((groups, item) => {
    const actual = valueType(item)
    if (!actual) return groups
    const type = hasDecimal && actual === "integer" ? "number" : actual
    const group = groups.find((entry) => entry.type === type)
    if (group) group.values.push(item)
    else groups.push({ type, values: [item] })
    return groups
  }, [])
}

function valueType(value: unknown) {
  if (value === null) return "null"
  if (typeof value === "string" || typeof value === "boolean") return typeof value
  if (typeof value === "number" && Number.isFinite(value)) return Number.isInteger(value) ? "integer" : "number"
}

function matchesType(value: unknown, type: string) {
  const actual = valueType(value)
  if (type === "number") return actual === "number" || actual === "integer"
  return actual === type
}

function collapse(branches: JsonRecord[]) {
  const projected = unique(branches)
  if (projected.length === 0) return {}
  if (projected.length === 1) return projected[0] ?? {}
  return { anyOf: projected }
}

function unique<T>(values: T[]) {
  return [...new Map(values.map((value) => [JSON.stringify(value), value])).values()]
}

function omit(source: JsonRecord, keys: string[]) {
  const omitted = new Set(keys)
  return Object.fromEntries(Object.entries(source).filter(([key]) => !omitted.has(key)))
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
