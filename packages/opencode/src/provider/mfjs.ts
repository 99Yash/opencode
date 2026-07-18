export * as MFJS from "./mfjs"

import type { JSONSchema7 } from "@ai-sdk/provider"

// MFJS specification and reference validator: https://github.com/MoonshotAI/walle

type JsonRecord = Record<string, unknown>
type Context = {
  root: JsonRecord
  definitions: JsonRecord
  properties: number
}
type Position = {
  depth: number
  definition: boolean
  root: boolean
}

const TYPES = new Set(["string", "number", "boolean", "integer", "object", "array", "null"])
const RESERVED_PROPERTIES = new Set(["$defs", "$ref", "anyOf", "required", "additionalProperties"])
const MAX_ANY_OF = 500
const MAX_ENUM = 1000
const MAX_DEPTH = 30
const MAX_PROPERTIES = 3000
const MAX_SCHEMA_SIZE = 120_000

// Moonshot accepts MFJS, a strict and intentionally smaller JSON Schema dialect.
// Lower broader schemas here so one incompatible tool cannot reject the whole request.
export function sanitize(value: unknown): JSONSchema7 {
  const root = isPlainObject(value) ? value : {}
  const definitions = collectDefinitions(root)
  const context = { root, definitions: referencedDefinitions(root, definitions), properties: 0 }
  const lowered = sanitizeNode(root, context, { depth: 0, definition: false, root: true })
  const rooted = forceObjectRoot(lowered, context)
  const referenced = pruneInvalidRefs(rooted, rooted)
  const terminating = ensureTermination(forceObjectRoot(referenced, context))
  const depthBounded =
    schemaDepth(terminating, terminating, new Set()) <= MAX_DEPTH ? terminating : emptyRoot(terminating)
  return fitSchemaSize(forceObjectRoot(depthBounded, context)) as JSONSchema7
}

function forceObjectRoot(result: JsonRecord, context: Context) {
  if (result.type === "object") return result
  if (typeof result.$ref === "string" && refIsObject(result.$ref, context)) return result
  if (Array.isArray(result.anyOf)) {
    const branches = result.anyOf.filter(isPlainObject).map((branch) => {
      if (branch.type === "object" || typeof branch.$ref !== "string" || !refIsObject(branch.$ref, context)) {
        return branch
      }
      const target = resolveRef(branch.$ref, context)
      return isPlainObject(target)
        ? sanitizeNode(target, context, { depth: 0, definition: false, root: false })
        : branch
    })
    if (branches.length > 0 && branches.every((branch) => branch.type === "object")) {
      return withMetadata(mergeObjectUnion(branches), result)
    }
  }
  return withMetadata({ type: "object", properties: {} }, result)
}

function sanitizeNode(value: unknown, context: Context, position: Position): JsonRecord {
  if (position.depth >= MAX_DEPTH) return {}
  if (value === true || value === false) return position.root ? { type: "object", properties: {} } : {}
  if (!isPlainObject(value)) return position.root ? { type: "object", properties: {} } : {}
  if (Object.keys(value).length === 0) return position.root ? { type: "object", properties: {} } : {}

  const source = lowerAllOf(value, context)
  const ref = rewriteRef(source.$ref)
  if (ref && refExists(ref, context)) {
    const siblings = Object.fromEntries(
      Object.entries(source).filter(([key]) => !["$ref", "description", "title", "default"].includes(key)),
    )
    if (Object.keys(siblings).length === 0) return withRootMetadata({ $ref: ref }, source, context, position)
    if (Object.keys(siblings).length === 1 && siblings.nullable === true) {
      return withRootMetadata({ anyOf: [{ $ref: ref }, { type: "null" }] }, source, context, position)
    }
    const target = resolveRef(ref, context)
    if (isPlainObject(target)) {
      return sanitizeNode({ ...target, ...siblings }, context, position)
    }
  }

  const typeList = Array.isArray(source.type)
    ? source.type.filter((item): item is string => typeof item === "string" && TYPES.has(item))
    : []
  const scalarType = typeof source.type === "string" && TYPES.has(source.type) ? source.type : undefined
  const enumValues = enumValuesOf("const" in source ? [source.const] : source.enum)
  const variants = Array.isArray(source.anyOf) ? source.anyOf : Array.isArray(source.oneOf) ? source.oneOf : undefined

  if (variants || typeList.length > 1 || source.nullable === true) {
    const unionBase = Object.fromEntries(
      Object.entries(source).filter(
        ([key]) => !["anyOf", "oneOf", "allOf", "nullable", "$defs", "definitions", "$id"].includes(key),
      ),
    )
    const branches = variants
      ? variants
          .slice(0, MAX_ANY_OF)
          .filter(isPlainObject)
          .map((branch) => intersect(unionBase, branch))
          .filter((branch): branch is JsonRecord => branch !== undefined)
      : (typeList.length > 0 ? typeList : [scalarType ?? inferType(source, groupEnum(enumValues))]).flatMap((type) => {
          const base = Object.fromEntries(
            Object.entries(unionBase).filter(([key]) => !["type", "enum", "const"].includes(key)),
          )
          const matching = enumValues.filter((item) => typeMatches(item, type))
          if (enumValues.length > 0 && matching.length === 0) return []
          return [{ ...base, type, ...(matching.length > 0 ? { enum: matching } : {}) }]
        })
    if (source.nullable === true && !branches.some((branch) => branch.type === "null")) branches.push({ type: "null" })

    const sanitized = branches
      .map((branch) => sanitizeNode(branch, context, child(position)))
      .flatMap((branch) => (Object.keys(branch).length === 1 && Array.isArray(branch.anyOf) ? branch.anyOf : [branch]))
    const unique = [...new Map(sanitized.map((branch) => [JSON.stringify(branch), branch])).values()]
    const result =
      unique.length === 1
        ? (unique[0] ?? {})
        : unique.length > 1
          ? { anyOf: unique.slice(0, MAX_ANY_OF) }
          : sanitizeNode(unionBase, context, position)
    return withRootMetadata(result, source, context, position)
  }

  const explicitType =
    typeof source.type === "string" && TYPES.has(source.type)
      ? source.type
      : typeList.length === 1
        ? typeList[0]
        : undefined
  const matchingEnum = explicitType ? enumValues.filter((item) => typeMatches(item, explicitType)) : enumValues
  const enumGroups = groupEnum(matchingEnum.length > 0 ? matchingEnum : enumValues)

  if (enumGroups.length > 1 || (enumGroups.length === 1 && enumValues.length > 0 && matchingEnum.length === 0)) {
    const base = Object.fromEntries(
      Object.entries(source).filter(([key]) => !["type", "enum", "const", "$defs", "definitions", "$id"].includes(key)),
    )
    const branches = enumGroups.map((group) =>
      sanitizeNode({ ...base, type: group.type, enum: group.values }, context, child(position)),
    )
    const result = branches.length === 1 ? (branches[0] ?? {}) : { anyOf: branches }
    return withRootMetadata(result, source, context, position)
  }

  const type = explicitType ?? inferType(source, enumGroups)
  const result: JsonRecord = { type }
  if (typeof source.description === "string") result.description = source.description
  if (typeof source.title === "string") result.title = source.title
  if ("default" in source && !position.definition) result.default = source.default

  if (type === "object") {
    if (isPlainObject(source.properties)) {
      const remaining = Math.max(0, MAX_PROPERTIES - context.properties)
      const entries = Object.entries(source.properties)
        .filter(
          ([name]) =>
            name.length > 0 && !RESERVED_PROPERTIES.has(name) && (!position.definition || !name.includes("/")),
        )
        .slice(0, remaining)
      context.properties += entries.length
      result.properties = Object.fromEntries(
        entries.map(([name, schema]) => [name, sanitizeNode(schema, context, child(position))]),
      )
    }
    const properties = isPlainObject(result.properties) ? result.properties : undefined
    if (Array.isArray(source.required) && properties) {
      const required = [
        ...new Set(
          source.required.filter(
            (item): item is string => typeof item === "string" && item.length > 0 && Object.hasOwn(properties, item),
          ),
        ),
      ]
      if (required.length > 0) result.required = required
    }
    if (typeof source.additionalProperties === "boolean") result.additionalProperties = source.additionalProperties
    if (isPlainObject(source.additionalProperties)) {
      result.additionalProperties =
        Object.keys(source.additionalProperties).length === 0
          ? {}
          : sanitizeNode(source.additionalProperties, context, child(position))
    }
  }

  if (type === "array") {
    const items = Array.isArray(source.items)
      ? source.items.filter(isPlainObject)
      : isPlainObject(source.items)
        ? [source.items]
        : Array.isArray(source.prefixItems)
          ? source.prefixItems.filter(isPlainObject)
          : []
    const sanitized = [
      ...new Map(
        items.map((item) => sanitizeNode(item, context, child(position))).map((item) => [JSON.stringify(item), item]),
      ).values(),
    ]
    if (sanitized.length === 1) result.items = sanitized[0]
    if (sanitized.length > 1) result.items = { anyOf: sanitized.slice(0, MAX_ANY_OF) }
    copyRange(result, source, "minItems", "maxItems", true, true)
  }

  if (type === "string") copyRange(result, source, "minLength", "maxLength", true, true)
  if (type === "number" || type === "integer") {
    const minimums = [
      ...(typeof source.minimum === "number" ? [source.minimum] : []),
      ...(type === "integer" && typeof source.exclusiveMinimum === "number"
        ? [Math.floor(source.exclusiveMinimum) + 1]
        : []),
    ]
    const maximums = [
      ...(typeof source.maximum === "number" ? [source.maximum] : []),
      ...(type === "integer" && typeof source.exclusiveMaximum === "number"
        ? [Math.ceil(source.exclusiveMaximum) - 1]
        : []),
    ]
    const minimum = minimums.length > 0 ? Math.max(...minimums) : undefined
    const maximum = maximums.length > 0 ? Math.min(...maximums) : undefined
    copyRange(result, { minimum, maximum }, "minimum", "maximum", type === "integer", false)
  }

  if (["string", "number", "integer", "boolean", "null"].includes(type)) {
    const values = (matchingEnum.length > 0 ? matchingEnum : (enumGroups[0]?.values ?? [])).filter((item) =>
      typeMatches(item, type),
    )
    if (values.length > 0) result.enum = values
  }

  return withRootMetadata(result, source, context, position)
}

function withRootMetadata(result: JsonRecord, source: JsonRecord, context: Context, position: Position) {
  if (!position.root) return result
  if (typeof source.$id === "string") result.$id = source.$id

  const sanitized = Object.fromEntries(
    Object.entries(context.definitions)
      .filter(([name, schema]) => name.length > 0 && !name.includes("/") && isPlainObject(schema))
      .map(([name, schema]) => [name, sanitizeNode(schema, context, { depth: 0, definition: true, root: false })]),
  )
  if (Object.keys(sanitized).length > 0) result.$defs = sanitized
  return result
}

function withMetadata(result: JsonRecord, source: JsonRecord) {
  if (typeof source.$id === "string") result.$id = source.$id
  if (isPlainObject(source.$defs)) result.$defs = source.$defs
  return result
}

function child(position: Position): Position {
  return { depth: position.depth + 1, definition: position.definition, root: false }
}

function pruneInvalidRefs(schema: JsonRecord, root: JsonRecord): JsonRecord {
  if (typeof schema.$ref === "string" && !resolveOutputRef(schema.$ref, root)) return {}

  const result = { ...schema }
  if (isPlainObject(schema.properties)) {
    result.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([name, property]) => [
        name,
        isPlainObject(property) ? pruneInvalidRefs(property, root) : {},
      ]),
    )
  }
  if (isPlainObject(schema.items)) result.items = pruneInvalidRefs(schema.items, root)
  if (isPlainObject(schema.additionalProperties)) {
    result.additionalProperties = pruneInvalidRefs(schema.additionalProperties, root)
  }
  if (Array.isArray(schema.anyOf)) {
    const branches = schema.anyOf.filter(isPlainObject).map((branch) => pruneInvalidRefs(branch, root))
    if (branches.length === 1) return withMetadata(branches[0] ?? {}, result)
    result.anyOf = branches
  }
  if (isPlainObject(schema.$defs)) {
    result.$defs = Object.fromEntries(
      Object.entries(schema.$defs).map(([name, definition]) => [
        name,
        isPlainObject(definition) ? pruneInvalidRefs(definition, root) : {},
      ]),
    )
  }
  return result
}

function resolveOutputRef(ref: string, root: JsonRecord): JsonRecord | undefined {
  if (ref === "#") return root
  if (!ref.startsWith("#/$defs/") || ref === "#/$defs/") return
  const parts = ref
    .slice("#/$defs/".length)
    .split("/")
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
  return parts.reduce<JsonRecord | undefined>((current, part, index) => {
    const value = index === 0 ? (isPlainObject(root.$defs) ? root.$defs[part] : undefined) : current?.[part]
    return isPlainObject(value) ? value : undefined
  }, undefined)
}

function ensureTermination(schema: JsonRecord) {
  if (terminates(schema, schema, new Set())) return schema
  if (schema.type === "object") {
    const { required: _, ...result } = schema
    return result
  }
  if (schema.type === "array") {
    const { items: _, ...result } = schema
    return result
  }
  return emptyRoot(schema)
}

function emptyRoot(source: JsonRecord) {
  return {
    type: "object",
    properties: {},
    ...(typeof source.$id === "string" ? { $id: source.$id } : {}),
  }
}

function terminates(schema: JsonRecord, root: JsonRecord, refs: Set<string>): boolean {
  const types = schemaTypes(schema.type)
  if (types.some((type) => type !== "object" && type !== "array")) return true

  if (types.includes("array")) {
    if (!isPlainObject(schema.items) || Object.keys(schema.items).length === 0) return true
    if (terminates(schema.items, root, new Set(refs))) return true
  }

  if (types.includes("object")) {
    const required = Array.isArray(schema.required)
      ? schema.required.filter((item): item is string => typeof item === "string")
      : []
    const properties = isPlainObject(schema.properties) ? schema.properties : undefined
    if (required.length === 0 || !properties || Object.keys(properties).length === 0) return true
    if (
      required.some((name) => {
        const property = properties[name]
        return isPlainObject(property) && terminates(property, root, new Set(refs))
      })
    ) {
      return true
    }
  }

  if (Array.isArray(schema.anyOf)) {
    if (schema.anyOf.some((branch) => isPlainObject(branch) && terminates(branch, root, new Set(refs)))) return true
  }

  if (typeof schema.$ref === "string") {
    if (refs.has(schema.$ref)) return false
    const target = resolveOutputRef(schema.$ref, root)
    if (!target) return false
    const next = new Set(refs)
    next.add(schema.$ref)
    return terminates(target, root, next)
  }
  return Object.keys(schema).length === 0
}

function fitSchemaSize(schema: JsonRecord) {
  if (schemaSize(schema) <= MAX_SCHEMA_SIZE) return schema
  const compact = stripAnnotations(schema)
  if (schemaSize(compact) <= MAX_SCHEMA_SIZE) return compact
  return { type: "object", properties: {} }
}

function schemaDepth(schema: JsonRecord, root: JsonRecord, refs: Set<string>): number {
  const properties = isPlainObject(schema.properties)
    ? Math.max(
        0,
        ...Object.values(schema.properties).map((item) =>
          isPlainObject(item) ? 1 + schemaDepth(item, root, refs) : 0,
        ),
      )
    : 0
  const items = isPlainObject(schema.items) ? schemaDepth(schema.items, root, refs) : 0
  const additionalProperties = isPlainObject(schema.additionalProperties)
    ? schemaDepth(schema.additionalProperties, root, refs)
    : 0
  const anyOf = Array.isArray(schema.anyOf)
    ? Math.max(0, ...schema.anyOf.map((item) => (isPlainObject(item) ? schemaDepth(item, root, refs) : 0)))
    : 0
  const definitions = isPlainObject(schema.$defs)
    ? Math.max(
        0,
        ...Object.values(schema.$defs).map((item) => (isPlainObject(item) ? schemaDepth(item, root, refs) : 0)),
      )
    : 0
  const ref = (() => {
    if (typeof schema.$ref !== "string" || refs.has(schema.$ref)) return 0
    const target = resolveOutputRef(schema.$ref, root)
    if (!target) return 0
    const next = new Set(refs)
    next.add(schema.$ref)
    return schemaDepth(target, root, next)
  })()
  return Math.max(properties, items, additionalProperties, anyOf, definitions, ref)
}

function stripAnnotations(value: JsonRecord): JsonRecord {
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, item]) => {
      if (["description", "title", "default"].includes(key)) return []
      if ((key === "properties" || key === "$defs") && isPlainObject(item)) {
        return [
          [
            key,
            Object.fromEntries(
              Object.entries(item).map(([name, schema]) => [
                name,
                isPlainObject(schema) ? stripAnnotations(schema) : schema,
              ]),
            ),
          ],
        ]
      }
      if (Array.isArray(item)) {
        return [[key, item.map((entry) => (isPlainObject(entry) ? stripAnnotations(entry) : entry))]]
      }
      return [[key, isPlainObject(item) ? stripAnnotations(item) : item]]
    }),
  )
}

function schemaSize(schema: JsonRecord) {
  const json = JSON.stringify(schema).replace(/[<>&\u2028\u2029]/g, (char) => {
    return `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`
  })
  return new TextEncoder().encode(json).byteLength
}

function mergeObjectUnion(branches: JsonRecord[]) {
  const propertyNames = new Set(
    branches.flatMap((branch) => (isPlainObject(branch.properties) ? Object.keys(branch.properties) : [])),
  )
  const properties = Object.fromEntries(
    [...propertyNames].map((name) => {
      const schemas = [
        ...new Map(
          branches
            .flatMap((branch) =>
              isPlainObject(branch.properties) && isPlainObject(branch.properties[name])
                ? [branch.properties[name]]
                : [],
            )
            .map((schema) => [JSON.stringify(schema), schema]),
        ).values(),
      ]
      return [name, schemas.length === 1 ? schemas[0] : { anyOf: schemas.slice(0, MAX_ANY_OF) }]
    }),
  )
  const first = Array.isArray(branches[0]?.required)
    ? branches[0].required.filter((item): item is string => typeof item === "string")
    : []
  const required = branches
    .map(
      (branch) =>
        new Set(Array.isArray(branch.required) ? branch.required.filter((item) => typeof item === "string") : []),
    )
    .reduce((common, branch) => common.filter((name) => branch.has(name)), first)
  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
    ...(branches.every((branch) => branch.additionalProperties === false) ? { additionalProperties: false } : {}),
  }
}

function lowerAllOf(source: JsonRecord, context: Context) {
  if (!Array.isArray(source.allOf)) return source
  const base = Object.fromEntries(Object.entries(source).filter(([key]) => key !== "allOf"))
  return source.allOf.filter(isPlainObject).reduce((result, branch) => {
    const ref = rewriteRef(branch.$ref)
    const target = ref ? resolveRef(ref, context) : undefined
    const next = isPlainObject(target) ? { ...target, ...branch, $ref: undefined } : branch
    return intersect(result, next) ?? merge(result, next)
  }, base)
}

function intersect(left: JsonRecord, right: JsonRecord): JsonRecord | undefined {
  const leftTypes = schemaTypes(left.type)
  const rightTypes = schemaTypes(right.type)
  const types =
    leftTypes.length > 0 && rightTypes.length > 0
      ? [
          ...new Set([
            ...leftTypes.filter((type) => rightTypes.includes(type)),
            ...((leftTypes.includes("integer") && rightTypes.includes("number")) ||
            (leftTypes.includes("number") && rightTypes.includes("integer"))
              ? ["integer"]
              : []),
          ]),
        ]
      : leftTypes.length > 0
        ? leftTypes
        : rightTypes
  if (leftTypes.length > 0 && rightTypes.length > 0 && types.length === 0) return

  const result = merge(left, right)
  const leftEnum = enumValuesOf("const" in left ? [left.const] : left.enum)
  const rightEnum = enumValuesOf("const" in right ? [right.const] : right.enum)
  if (leftEnum.length > 0 && rightEnum.length > 0) {
    const intersection = leftEnum.filter((item) => rightEnum.some((other) => Object.is(item, other)))
    if (intersection.length === 0) return
    delete result.const
    result.enum = intersection
  }
  if (types.length === 1) result.type = types[0]
  if (types.length > 1) result.type = types
  if (Array.isArray(left.enum) && Array.isArray(right.enum) && Array.isArray(result.enum) && result.enum.length === 0) {
    return
  }

  for (const [minimumKey, maximumKey] of [
    ["minimum", "maximum"],
    ["minLength", "maxLength"],
    ["minItems", "maxItems"],
  ] as const) {
    const minimums = [left[minimumKey], right[minimumKey]].filter(
      (item): item is number => typeof item === "number" && Number.isFinite(item),
    )
    const maximums = [left[maximumKey], right[maximumKey]].filter(
      (item): item is number => typeof item === "number" && Number.isFinite(item),
    )
    if (minimums.length > 0) result[minimumKey] = Math.max(...minimums)
    if (maximums.length > 0) result[maximumKey] = Math.min(...maximums)
    if (
      typeof result[minimumKey] === "number" &&
      typeof result[maximumKey] === "number" &&
      result[minimumKey] > result[maximumKey]
    ) {
      return
    }
  }
  return result
}

function merge(left: JsonRecord, right: JsonRecord): JsonRecord {
  const result = { ...left, ...right }
  if (isPlainObject(left.properties) || isPlainObject(right.properties)) {
    const names = new Set([
      ...Object.keys(isPlainObject(left.properties) ? left.properties : {}),
      ...Object.keys(isPlainObject(right.properties) ? right.properties : {}),
    ])
    result.properties = Object.fromEntries(
      [...names].map((name) => {
        const a =
          isPlainObject(left.properties) && isPlainObject(left.properties[name]) ? left.properties[name] : undefined
        const b =
          isPlainObject(right.properties) && isPlainObject(right.properties[name]) ? right.properties[name] : undefined
        return [name, a && b ? (intersect(a, b) ?? b) : (b ?? a)]
      }),
    )
  }
  if (Array.isArray(left.required) || Array.isArray(right.required)) {
    result.required = [
      ...new Set([
        ...(Array.isArray(left.required) ? left.required : []),
        ...(Array.isArray(right.required) ? right.required : []),
      ]),
    ]
  }
  if (left.additionalProperties === false || right.additionalProperties === false) result.additionalProperties = false
  if (Array.isArray(left.enum) && Array.isArray(right.enum)) {
    const rightEnum = right.enum
    result.enum = left.enum.filter((item) => rightEnum.some((other) => Object.is(item, other)))
  }
  return result
}

function rewriteRef(value: unknown) {
  if (typeof value !== "string") return
  const ref = value.replace("#/definitions/", "#/$defs/")
  if (ref === "#" || ref.startsWith("#/$defs/")) return ref
}

function refExists(ref: string, context: Context) {
  if (ref === "#") return true
  return ref !== "#/$defs/" && isPlainObject(resolveRef(ref, context))
}

function refIsObject(ref: string, context: Context) {
  const target = resolveRef(ref, context)
  if (!isPlainObject(target)) return false
  const lowered = lowerAllOf(target, context)
  return lowered.type === "object" || isPlainObject(lowered.properties)
}

function resolveRef(ref: string, context: Context): unknown {
  if (ref === "#") return context.root
  return ref
    .slice("#/$defs/".length)
    .split("/")
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
    .reduce<unknown>((current, part, index) => {
      if (index === 0) return context.definitions[part]
      if (!isPlainObject(current)) return
      return current[part]
    }, undefined)
}

function collectDefinitions(root: JsonRecord) {
  return {
    ...(isPlainObject(root.definitions) ? root.definitions : {}),
    ...(isPlainObject(root.$defs) ? root.$defs : {}),
  }
}

function referencedDefinitions(root: JsonRecord, definitions: JsonRecord) {
  const names = new Set<string>()
  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      value.forEach(visit)
      return
    }
    if (!isPlainObject(value)) return

    const ref = rewriteRef(value.$ref)
    if (ref?.startsWith("#/$defs/")) {
      const name = ref.slice("#/$defs/".length).split("/", 1)[0]?.replaceAll("~1", "/").replaceAll("~0", "~")
      if (name && !names.has(name) && isPlainObject(definitions[name])) {
        names.add(name)
        visit(definitions[name])
      }
    }
    Object.entries(value).forEach(([key, item]) => {
      if (key !== "$defs" && key !== "definitions") visit(item)
    })
  }
  visit(root)
  return Object.fromEntries([...names].map((name) => [name, definitions[name]]))
}

function schemaTypes(value: unknown) {
  if (typeof value === "string" && TYPES.has(value)) return [value]
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((item): item is string => typeof item === "string" && TYPES.has(item)))]
}

function enumValuesOf(value: unknown) {
  if (!Array.isArray(value)) return []
  return [
    ...new Map(value.filter((item) => valueType(item)).map((item) => [JSON.stringify(item), item])).values(),
  ].slice(0, MAX_ENUM)
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

function typeMatches(value: unknown, type: string) {
  const actual = valueType(value)
  if (type === "number") return actual === "number" || actual === "integer"
  return actual === type
}

function inferType(source: JsonRecord, enumGroups: { type: string; values: unknown[] }[]) {
  if (["properties", "required", "additionalProperties"].some((key) => key in source)) return "object"
  if (["items", "prefixItems", "minItems", "maxItems"].some((key) => key in source)) return "array"
  if (["minLength", "maxLength", "format", "pattern"].some((key) => key in source)) return "string"
  if (["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"].some((key) => key in source)) {
    return "number"
  }
  return enumGroups[0]?.type ?? "string"
}

function copyRange(
  result: JsonRecord,
  source: JsonRecord,
  minimumKey: "minItems" | "minLength" | "minimum",
  maximumKey: "maxItems" | "maxLength" | "maximum",
  integer: boolean,
  nonNegative: boolean,
) {
  const valid = (value: unknown) =>
    typeof value === "number" &&
    Number.isFinite(value) &&
    (!integer || Number.isInteger(value)) &&
    (!nonNegative || value >= 0)
  const minimum = valid(source[minimumKey]) ? source[minimumKey] : undefined
  const maximum = valid(source[maximumKey]) ? source[maximumKey] : undefined
  if (typeof minimum === "number" && typeof maximum === "number" && minimum > maximum) return
  if (minimum !== undefined) result[minimumKey] = minimum
  if (maximum !== undefined) result[maximumKey] = maximum
}

function isPlainObject(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
