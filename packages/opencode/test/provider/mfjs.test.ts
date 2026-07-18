import { describe, expect, test } from "bun:test"
import { MFJS } from "@/provider/mfjs"

function expectProjection(input: unknown, expected: unknown) {
  expect(JSON.stringify(MFJS.sanitize(input))).toBe(JSON.stringify(expected))
}

function asObject(value: unknown) {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>
  throw new Error("expected object")
}

describe("MFJS.sanitize", () => {
  test("removes reference siblings and normalizes draft-07 definitions", () => {
    expect(
      MFJS.sanitize({
        type: "object",
        properties: {
          value: { $ref: "#/definitions/Value", description: "drop me" },
        },
        definitions: {
          Value: { type: "object", description: "keep me" },
        },
      }),
    ).toEqual({
      type: "object",
      properties: { value: { $ref: "#/$defs/Value" } },
      $defs: { Value: { type: "object", description: "keep me" } },
    })
  })

  test("preserves nullable reference semantics", () => {
    expect(
      MFJS.sanitize({
        type: "object",
        properties: { value: { $ref: "#/$defs/Value", nullable: true } },
        $defs: { Value: { type: "object" } },
      }),
    ).toEqual({
      type: "object",
      properties: { value: { anyOf: [{ $ref: "#/$defs/Value" }, { type: "null" }] } },
      $defs: { Value: { type: "object" } },
    })
  })

  test("keeps explicit types and removes incompatible enum values", () => {
    expect(
      MFJS.sanitize({
        type: "object",
        properties: { operation: { type: "object", enum: ["move", "copy"] } },
        required: ["operation"],
      }),
    ).toEqual({
      type: "object",
      properties: { operation: { type: "object" } },
      required: ["operation"],
    })
  })

  test("removes only enum values excluded by an explicit type", () => {
    expect(
      MFJS.sanitize({
        type: "object",
        properties: { operation: { type: "string", enum: ["move", null] } },
      }),
    ).toEqual({
      type: "object",
      properties: { operation: { type: "string", enum: ["move"] } },
    })
  })

  test("infers a type for homogeneous untyped enums", () => {
    expect(
      MFJS.sanitize({
        type: "object",
        properties: { operation: { enum: ["move", "copy"] } },
      }),
    ).toEqual({
      type: "object",
      properties: { operation: { type: "string", enum: ["move", "copy"] } },
    })
  })

  test("splits mixed untyped enums into homogeneous branches", () => {
    expect(
      MFJS.sanitize({
        type: "object",
        properties: { value: { enum: ["move", 1] } },
      }),
    ).toEqual({
      type: "object",
      properties: {
        value: {
          anyOf: [
            { type: "string", enum: ["move"] },
            { type: "integer", enum: [1] },
          ],
        },
      },
    })
  })

  test("drops tuple items instead of narrowing positional schemas", () => {
    expect(
      MFJS.sanitize({
        type: "object",
        properties: {
          values: {
            type: "array",
            items: [{ type: "string" }, { type: "number" }],
            minItems: 2,
          },
        },
      }),
    ).toEqual({
      type: "object",
      properties: { values: { type: "array", minItems: 2 } },
    })
  })

  test("preserves prefixItems accepted by Kimi", () => {
    expectProjection(
      {
        type: "object",
        properties: {
          values: { type: "array", prefixItems: [{ type: "string" }, { type: "number" }] },
        },
      },
      {
        type: "object",
        properties: {
          values: { type: "array", prefixItems: [{ type: "string" }, { type: "number" }] },
        },
      },
    )
  })

  test("moves parent types into compatible anyOf branches", () => {
    expect(
      MFJS.sanitize({
        type: "object",
        properties: {
          value: {
            type: "string",
            enum: ["move"],
            anyOf: [{ type: "string" }, { type: "null" }],
          },
        },
      }),
    ).toEqual({
      type: "object",
      properties: { value: { type: "string", enum: ["move"] } },
    })
  })

  test("preserves type arrays and nullable accepted by Kimi", () => {
    expectProjection(
      {
        type: "object",
        properties: {
          typed: { type: ["string", "null"], enum: ["move", null] },
          nullable: { type: "string", nullable: true },
        },
      },
      {
        type: "object",
        properties: {
          typed: { type: ["string", "null"], enum: ["move", null] },
          nullable: { type: "string", nullable: true },
        },
      },
    )
  })

  test("preserves oneOf, allOf, and other keywords accepted by Kimi", () => {
    const value = {
      oneOf: [
        { type: "string", format: "uri" },
        { type: "integer", multipleOf: 2 },
      ],
      examples: ["https://example.com"],
    }
    const all = {
      allOf: [
        { type: "object", properties: { left: { type: "string" } } },
        { type: "object", properties: { right: { type: "number" } } },
      ],
    }
    expectProjection(
      { type: "object", properties: { value, all }, unevaluatedProperties: false },
      { type: "object", properties: { value, all }, unevaluatedProperties: false },
    )
  })

  test("preserves const accepted by Kimi", () => {
    expect(
      MFJS.sanitize({
        type: "object",
        properties: { operation: { const: "move" } },
      }),
    ).toEqual({
      type: "object",
      properties: { operation: { const: "move" } },
    })
  })

  test("drops unresolved references", () => {
    expect(
      MFJS.sanitize({
        type: "object",
        properties: { value: { $ref: "#/definitions/Missing" } },
      }),
    ).toEqual({
      type: "object",
      properties: { value: {} },
    })
  })

  test("adds unconstrained schemas for dangling required properties", () => {
    expect(
      MFJS.sanitize({
        type: "object",
        properties: {},
        required: ["missing"],
      }),
    ).toEqual({
      type: "object",
      properties: { missing: {} },
      required: ["missing"],
    })
  })

  test("preserves unconstrained schemas", () => {
    expect(
      MFJS.sanitize({
        type: "object",
        properties: { empty: {}, truthy: true, falsy: false },
      }),
    ).toEqual({
      type: "object",
      properties: { empty: {}, truthy: {}, falsy: {} },
    })
  })

  test("widens schemas that exceed Kimi limits", () => {
    const properties = Object.fromEntries(
      Array.from({ length: 3001 }, (_, index) => [`property_${index}`, { type: "string" }]),
    )
    const limited = asObject(MFJS.sanitize({ type: "object", properties }))
    expect(Object.keys(asObject(limited.properties))).toHaveLength(3000)

    expect(
      MFJS.sanitize({
        type: "object",
        properties: {
          value: { type: "string", enum: Array.from({ length: 1001 }, (_, index) => `value_${index}`) },
        },
      }),
    ).toEqual({
      type: "object",
      properties: { value: { type: "string" } },
    })

    expect(
      MFJS.sanitize({
        type: "object",
        properties: {
          value: { anyOf: Array.from({ length: 501 }, (_, index) => ({ const: `value_${index}` })) },
        },
      }),
    ).toEqual({
      type: "object",
      properties: { value: {} },
    })

    const deep = Array.from({ length: 35 }).reduce<Record<string, unknown>>(
      (schema) => ({ type: "object", properties: { next: schema }, required: ["next"] }),
      { type: "string" },
    )
    expect(JSON.stringify(MFJS.sanitize(deep)).match(/properties/g)?.length).toBe(30)

    expect(MFJS.sanitize({ type: "object", description: "<".repeat(20_000), properties: {} })).toEqual({
      type: "object",
      properties: {},
    })

    const definition = Array.from({ length: 30 }).reduce<Record<string, unknown>>(
      (schema) => ({ type: "object", properties: { next: schema } }),
      { type: "string" },
    )
    expect(
      MFJS.sanitize({
        type: "object",
        properties: { value: { $ref: "#/$defs/Value" } },
        $defs: { Value: definition },
      }),
    ).toEqual({ type: "object", properties: {} })
  })

  test("is idempotent", () => {
    const once = MFJS.sanitize({
      type: "object",
      properties: {
        operation: { type: "object", enum: ["move"] },
        values: { type: "array", items: [{ type: "string" }, { type: "number" }] },
      },
    })
    expect(MFJS.sanitize(once)).toEqual(once)
  })
})
