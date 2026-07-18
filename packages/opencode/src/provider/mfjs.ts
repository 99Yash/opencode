export * as MFJS from "./mfjs"

import type { JSONSchema7 } from "@ai-sdk/provider"

/**
 * Kimi tool-schema compatibility projection.
 *
 * Principles:
 * - Preserve schema features accepted by Kimi without rewriting them.
 * - Apply model-agnostic adaptations only for reproduced provider rejections.
 * - Keep explicit types authoritative; lossy fallbacks may widen but never narrow.
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
  legacy: Record<string, string>
  properties: number
}
type Projection = {
  schema: JsonRecord
  // Unsafe projections cannot stay under non-monotonic applicators without risking narrowing.
  unsafe: boolean
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
const SCHEMA_LISTS = new Set(["allOf", "prefixItems"])
const MAX_ANY_OF = 500
const MAX_DEPTH = 30
const MAX_ENUM = 1000
const MAX_PROPERTIES = 3000
const MAX_RECURSION = 1000
const MAX_SCHEMA_SIZE = 120_000

/**
 * Projects tool schemas only where Kimi rejects otherwise valid requests.
 * Accepted keywords are preserved, explicit types remain authoritative, and
 * lossy fallbacks only widen what the model may emit.
 */
export function sanitize(value: unknown): JSONSchema7 {
  const root = isRecord(value) ? value : {}
  const sourceDefinitions = definitions(root)
  const context = { root, definitions: sourceDefinitions.schemas, legacy: sourceDefinitions.legacy, properties: 0 }
  const projected = project(root, context, 0, 0).schema
  const defs = Object.fromEntries(
    Object.entries(context.definitions)
      .filter(([name, schema]) => name.length > 0 && !name.includes("/") && isRecord(schema))
      .map(([name, schema]) => [name, containsSlashKey(schema) ? {} : project(schema, context, 0, 0).schema]),
  )
  if (Object.keys(defs).length > 0) projected.$defs = defs
  const resolved = dropDanglingRefs(projected, projected)
  const bounded =
    (containsRef(resolved) && !terminates(resolved, resolved, new Set())) ||
    schemaDepth(resolved, resolved, new Set()) > MAX_DEPTH
      ? { type: "object", properties: {} }
      : resolved
  return fitSize(bounded) as JSONSchema7
}

function project(value: unknown, context: Context, depth: number, recursion: number): Projection {
  if (depth >= MAX_DEPTH || recursion >= MAX_RECURSION) return { schema: {}, unsafe: true }
  if (!isRecord(value) || Object.keys(value).length === 0) {
    return { schema: {}, unsafe: !isRecord(value) }
  }

  const ref = canonicalRef(value.$ref, context)
  if (ref) {
    const schema = value.nullable === true ? { anyOf: [{ $ref: ref }, { type: "null" }] } : { $ref: ref }
    return {
      schema,
      // References are conservative here because their projected targets may widen later.
      unsafe: true,
    }
  }

  const declaredTypes = schemaTypes(value.type)
  const inferredTypes =
    declaredTypes.length > 0
      ? declaredTypes
      : groupEnum(enumValues("const" in value ? [value.const] : value.enum)).map((group) => group.type)
  if (Array.isArray(value.anyOf) && inferredTypes.length > 0) {
    return projectTypedAnyOf(
      { ...value, type: inferredTypes.length === 1 ? inferredTypes[0] : inferredTypes },
      context,
      depth,
      recursion,
    )
  }

  const result: JsonRecord = {}
  let unsafe = "$ref" in value || "$defs" in value || "definitions" in value
  let truncatedProperties = false
  let widenedContains = false
  const child = (item: unknown, nextDepth = depth, nextContext = context) =>
    project(item, nextContext, nextDepth, recursion + 1)
  const keep = (projection: Projection) => {
    unsafe ||= projection.unsafe
    return projection.schema
  }
  const condition = (() => {
    if (!isRecord(value.if)) return
    const nested = { ...context }
    const projection = child(value.if, depth, nested)
    if (!projection.unsafe) context.properties = nested.properties
    return projection
  })()
  for (const [key, item] of Object.entries(value)) {
    if (key === "$defs" || key === "definitions") continue
    if (key === "$ref") continue
    if (key === "items" && Array.isArray(item)) {
      unsafe = true
      continue
    }
    if (key === "items" && (item === true || item === false)) {
      result.items = {}
      unsafe = true
      continue
    }
    if (key === "anyOf" && Array.isArray(item)) {
      if (item.length > 0 && item.length <= MAX_ANY_OF) {
        result.anyOf = item.map((branch) => keep(child(branch)))
      } else {
        unsafe = true
      }
      continue
    }
    if (key === "oneOf" && Array.isArray(item)) {
      const nested = { ...context }
      const branches = item.map((branch) => child(branch, depth, nested))
      const risky = branches.some((branch) => branch.unsafe)
      const useBranches =
        !risky || (!Array.isArray(value.anyOf) && branches.length > 0 && branches.length <= MAX_ANY_OF)
      if (!risky) result.oneOf = branches.map((branch) => branch.schema)
      if (risky && useBranches) result.anyOf = branches.map((branch) => branch.schema)
      if (useBranches) context.properties = nested.properties
      unsafe ||= risky
      continue
    }
    if (SCHEMA_LISTS.has(key) && Array.isArray(item)) {
      result[key] = item.map((schema) => keep(child(schema)))
      continue
    }
    if (key === "not" && isRecord(item)) {
      const nested = { ...context }
      const schema = child(item, depth, nested)
      if (!schema.unsafe) {
        result.not = schema.schema
        context.properties = nested.properties
      } else {
        unsafe = true
      }
      continue
    }
    if (key === "if" || key === "then" || key === "else") {
      if (condition?.unsafe) {
        unsafe = true
        continue
      }
      if (key === "if" && condition) {
        result.if = condition.schema
        continue
      }
      if (isRecord(item)) {
        result[key] = keep(child(item))
        continue
      }
      result[key] = item
      continue
    }
    if (key === "properties" && isRecord(item)) {
      const remaining = Math.max(0, MAX_PROPERTIES - context.properties)
      const entries = Object.entries(item).slice(0, remaining)
      context.properties += entries.length
      truncatedProperties = entries.length !== Object.keys(item).length
      result.properties = Object.fromEntries(entries.map(([name, schema]) => [name, keep(child(schema, depth + 1))]))
      unsafe ||= truncatedProperties
      continue
    }
    if (SCHEMA_MAPS.has(key) && isRecord(item)) {
      const schemas = Object.entries(item).map(([name, schema]) => [name, child(schema)] as const)
      result[key] = Object.fromEntries(
        schemas.map(([name, schema]) => [name, typeof schema.schema.$ref === "string" ? {} : schema.schema]),
      )
      unsafe ||= schemas.some(([, schema]) => schema.unsafe)
      continue
    }
    if (key === "contains" && isRecord(item)) {
      const schema = child(item)
      result.contains = schema.schema
      widenedContains = schema.unsafe
      keep(schema)
      continue
    }
    if ((key === "items" || SCHEMA_NODES.has(key)) && isRecord(item)) {
      result[key] = keep(child(item))
      continue
    }
    result[key] = item
  }
  unsafe ||= projectRequired(result, context)
  if (truncatedProperties) delete result.additionalProperties
  if (widenedContains && "maxContains" in result) {
    delete result.maxContains
    unsafe = true
  }
  const projected = projectEnum(result)
  unsafe ||= projected.unsafe
  if ("unevaluatedProperties" in projected.schema && unsafe) {
    delete projected.schema.unevaluatedProperties
    unsafe = true
  }
  return { schema: projected.schema, unsafe }
}

function projectTypedAnyOf(source: JsonRecord, context: Context, depth: number, recursion: number): Projection {
  const base = omit(source, ["anyOf", "type", "enum", "const", "$defs", "definitions"])
  const parentTypes = schemaTypes(source.type)
  const parentEnum = enumValues("const" in source ? [source.const] : source.enum)
  const variants = Array.isArray(source.anyOf) ? source.anyOf : []
  if (variants.length > MAX_ANY_OF) {
    const projected = project(omit(source, ["anyOf", "unevaluatedProperties"]), context, depth, recursion + 1)
    return { ...projected, unsafe: true }
  }
  const branches = variants.flatMap((branch) => {
    if (branch === false) return []
    const item = branch === true ? {} : isRecord(branch) ? branch : undefined
    if (!item) return []
    const types = intersectTypes(parentTypes, schemaTypes(item.type))
    if (types.length === 0) return []
    const branchEnum = enumValues("const" in item ? [item.const] : item.enum)
    const values = intersectEnums(parentEnum, branchEnum).filter((value) =>
      types.some((type) => matchesType(value, type)),
    )
    if ((parentEnum.length > 0 || branchEnum.length > 0) && values.length === 0) return []
    const merged = omit({ ...base, ...item }, ["type", "enum", "const"])
    const projected = project(
      {
        ...merged,
        type: types.length === 1 ? types[0] : types,
        ...(values.length > 0 ? { enum: values } : {}),
      },
      context,
      depth,
      recursion + 1,
    )
    return [projected.schema]
  })
  return { schema: collapse(branches), unsafe: true }
}

function projectEnum(source: JsonRecord): Projection {
  const result = { ...source }
  const values = enumValues(result.enum)
  if (values.length === 0) {
    const unsafe = "enum" in result
    delete result.enum
    return { schema: result, unsafe }
  }

  const types = schemaTypes(result.type)
  if (types.length > 0) {
    const compatible = values.filter((value) => types.some((type) => matchesType(value, type)))
    if (compatible.length === 0) {
      delete result.enum
      return { schema: result, unsafe: true }
    }
    const nullable =
      types.length === 2 && types.includes("null") && !types.includes("object") && !types.includes("array")
    if (types.length === 1 || nullable) {
      result.enum = compatible
      return { schema: result, unsafe: !same(result.enum, source.enum) }
    }
    const base = omit(result, ["enum", "type"])
    return {
      schema: collapse(groupEnum(compatible).map((group) => ({ ...base, type: group.type, enum: group.values }))),
      unsafe: true,
    }
  }

  const groups = groupEnum(values)
  if (groups.length === 1) {
    result.type = groups[0]?.type
    result.enum = groups[0]?.values
    return { schema: result, unsafe: true }
  }
  const base = omit(result, ["enum", "type"])
  return {
    schema: { anyOf: groups.map((group) => ({ ...base, type: group.type, enum: group.values })) },
    unsafe: true,
  }
}

function projectRequired(schema: JsonRecord, context: Context) {
  if (!Array.isArray(schema.required)) return false
  const types = schemaTypes(schema.type)
  if (types.length > 0 && !types.includes("object")) {
    delete schema.required
    return true
  }
  const sourceProperties = isRecord(schema.properties) ? schema.properties : undefined
  const properties = { ...sourceProperties }
  const sourceRequired = schema.required
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
  return (
    !sourceProperties ||
    !same(Object.keys(sourceProperties), Object.keys(properties)) ||
    !same(sourceRequired, required)
  )
}

function fitSize(schema: JsonRecord) {
  if (schemaSize(schema) <= MAX_SCHEMA_SIZE) return schema
  const compact = stripAnnotations(schema)
  if (schemaSize(compact) <= MAX_SCHEMA_SIZE) return compact
  return {}
}

function stripAnnotations(schema: JsonRecord): JsonRecord {
  return Object.fromEntries(
    Object.entries(schema).flatMap(([key, value]) => {
      if (["description", "title", "default", "examples", "$comment"].includes(key)) return []
      if ((key === "properties" || key === "$defs" || SCHEMA_MAPS.has(key)) && isRecord(value)) {
        return [
          [
            key,
            Object.fromEntries(
              Object.entries(value).map(([name, item]) => [name, isRecord(item) ? stripAnnotations(item) : item]),
            ),
          ],
        ]
      }
      if ((key === "anyOf" || key === "oneOf" || SCHEMA_LISTS.has(key)) && Array.isArray(value)) {
        return [[key, value.map((item) => (isRecord(item) ? stripAnnotations(item) : item))]]
      }
      if ((key === "items" || SCHEMA_NODES.has(key)) && isRecord(value)) {
        return [[key, stripAnnotations(value)]]
      }
      return [[key, value]]
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
  return [...nodes, ...lists, ...definitions, ref].reduce((max, value) => Math.max(max, value), properties)
}

function dropDanglingRefs(schema: JsonRecord, root: JsonRecord): JsonRecord {
  if (typeof schema.$ref === "string" && !resolveOutputRef(schema.$ref, root)) return {}
  return Object.fromEntries(
    Object.entries(schema).map(([key, value]) => {
      if ((key === "properties" || key === "$defs" || SCHEMA_MAPS.has(key)) && isRecord(value)) {
        return [
          key,
          Object.fromEntries(
            Object.entries(value).map(([name, item]) => [name, isRecord(item) ? dropDanglingRefs(item, root) : item]),
          ),
        ]
      }
      if ((key === "anyOf" || key === "oneOf" || SCHEMA_LISTS.has(key)) && Array.isArray(value)) {
        return [key, value.map((item) => (isRecord(item) ? dropDanglingRefs(item, root) : item))]
      }
      if ((key === "items" || SCHEMA_NODES.has(key)) && isRecord(value)) {
        return [key, dropDanglingRefs(value, root)]
      }
      return [key, value]
    }),
  )
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

function terminates(schema: JsonRecord, root: JsonRecord, refs: Set<string>): boolean {
  const types = schemaTypes(schema.type)
  if (types.some((type) => type !== "object" && type !== "array")) return true
  if (types.includes("array")) {
    if (!isRecord(schema.items) || Object.keys(schema.items).length === 0) return true
    if (terminates(schema.items, root, refs)) return true
  }
  if (types.includes("object")) {
    if (!Array.isArray(schema.required) || schema.required.length === 0) return true
    const properties = isRecord(schema.properties) ? schema.properties : undefined
    if (!properties || Object.keys(properties).length === 0) return true
    if (
      schema.required.some((name) => {
        const property = typeof name === "string" ? properties[name] : undefined
        return isRecord(property) && terminates(property, root, refs)
      })
    ) {
      return true
    }
  }
  if (
    Array.isArray(schema.anyOf) &&
    (schema.anyOf.length === 0 || schema.anyOf.some((item) => isRecord(item) && terminates(item, root, new Set(refs))))
  ) {
    return true
  }
  if (typeof schema.$ref === "string") {
    if (refs.has(schema.$ref)) return false
    const target = resolveOutputRef(schema.$ref, root)
    if (!target) return true
    const next = new Set(refs)
    next.add(schema.$ref)
    return terminates(target, root, next)
  }
  return Object.keys(schema).length === 0
}

function canonicalRef(value: unknown, context: Context) {
  if (typeof value !== "string") return
  if (value.includes("~0") || value.includes("~1")) return
  const ref = (() => {
    if (!value.startsWith("#/definitions/")) return value
    const parts = value.slice("#/definitions/".length).split("/")
    const name = parts[0]?.replaceAll("~1", "/").replaceAll("~0", "~")
    if (!name || !context.legacy[name]) return
    return `#/$defs/${context.legacy[name]?.replaceAll("~", "~0").replaceAll("/", "~1")}${
      parts.length > 1 ? `/${parts.slice(1).join("/")}` : ""
    }`
  })()
  if (!ref) return
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
  const modern = isRecord(root.$defs) ? root.$defs : {}
  const schemas = { ...modern }
  const legacy = Object.fromEntries(
    Object.entries(isRecord(root.definitions) ? root.definitions : {}).map(([name, schema]) => {
      const target =
        !Object.hasOwn(schemas, name) || same(schemas[name], schema) ? name : uniqueDefinition(name, schemas)
      schemas[target] = schema
      return [name, target]
    }),
  )
  return { schemas, legacy }
}

function uniqueDefinition(name: string, schemas: JsonRecord, index = 1): string {
  const candidate = `${name}__definitions${index === 1 ? "" : `_${index}`}`
  if (!Object.hasOwn(schemas, candidate)) return candidate
  return uniqueDefinition(name, schemas, index + 1)
}

function containsSlashKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsSlashKey)
  if (!isRecord(value)) return false
  return Object.entries(value).some(([key, item]) => key.includes("/") || containsSlashKey(item))
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

function same(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function containsRef(value: unknown): boolean {
  if (!isRecord(value)) return false
  if (typeof value.$ref === "string") return true
  const maps = [value.properties, value.$defs, value.definitions, ...[...SCHEMA_MAPS].map((key) => value[key])]
  if (maps.some((map) => isRecord(map) && Object.values(map).some(containsRef))) return true
  const nodes = [value.items, ...[...SCHEMA_NODES].map((key) => value[key])]
  if (nodes.some(containsRef)) return true
  return [value.anyOf, value.oneOf, ...[...SCHEMA_LISTS].map((key) => value[key])].some(
    (items) => Array.isArray(items) && items.some(containsRef),
  )
}

function omit(source: JsonRecord, keys: string[]) {
  const omitted = new Set(keys)
  return Object.fromEntries(Object.entries(source).filter(([key]) => !omitted.has(key)))
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
