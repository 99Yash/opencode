import { describe, expect, test } from "bun:test"
import { MFJS } from "@/provider/mfjs"

function asObject(value: unknown) {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>
  throw new Error("expected object")
}

describe("MFJS.sanitize", () => {
  test("removes siblings from references while preserving definitions", () => {
    expect(
      MFJS.sanitize({
        type: "object",
        properties: {
          value: {
            $ref: "#/$defs/Value",
            description: "Moonshot rejects siblings after expanding a reference.",
          },
        },
        $defs: {
          Value: { type: "object", description: "The referenced description remains here." },
        },
      }),
    ).toEqual({
      type: "object",
      properties: { value: { $ref: "#/$defs/Value" } },
      $defs: {
        Value: { type: "object", description: "The referenced description remains here." },
      },
    })
  })

  test("repairs enum types that contradict their values", () => {
    expect(
      MFJS.sanitize({
        type: "object",
        properties: {
          operation: { type: "object", enum: ["move", "copy"] },
        },
        required: ["operation"],
      }),
    ).toEqual({
      type: "object",
      properties: {
        operation: { type: "string", enum: ["move", "copy"] },
      },
      required: ["operation"],
    })
  })

  test("lowers type arrays and nullable enums to anyOf", () => {
    expect(
      MFJS.sanitize({
        type: "object",
        properties: {
          operation: { type: ["string", "null"], enum: ["move", null] },
        },
      }),
    ).toEqual({
      type: "object",
      properties: {
        operation: {
          anyOf: [
            { type: "string", enum: ["move"] },
            { type: "null", enum: [null] },
          ],
        },
      },
    })
  })

  test("normalizes single-value type arrays", () => {
    expect(
      MFJS.sanitize({
        type: "object",
        properties: { value: { type: ["null"] } },
      }),
    ).toEqual({
      type: "object",
      properties: { value: { type: "null" } },
    })
  })

  test("preserves scalar types when lowering nullable schemas", () => {
    expect(
      MFJS.sanitize({
        type: "object",
        properties: { value: { type: "string", nullable: true } },
      }),
    ).toEqual({
      type: "object",
      properties: {
        value: { anyOf: [{ type: "string" }, { type: "null" }] },
      },
    })
  })

  test("intersects parent constraints into anyOf branches", () => {
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

  test("infers missing types and filters dangling required fields", () => {
    expect(
      MFJS.sanitize({
        properties: {
          mode: { enum: ["fast", "safe"] },
          options: { properties: { retries: { type: "integer" } } },
          values: { items: { type: "number" } },
        },
        required: ["mode", "missing"],
      }),
    ).toEqual({
      type: "object",
      properties: {
        mode: { type: "string", enum: ["fast", "safe"] },
        options: { type: "object", properties: { retries: { type: "integer" } } },
        values: { type: "array", items: { type: "number" } },
      },
      required: ["mode"],
    })
  })

  test("converts oneOf and strips unsupported keywords", () => {
    expect(
      MFJS.sanitize({
        type: "object",
        $schema: "https://json-schema.org/draft/2020-12/schema",
        properties: {
          value: {
            oneOf: [
              { type: "string", format: "uri" },
              { type: "integer", multipleOf: 2 },
            ],
            examples: ["https://example.com"],
          },
        },
        unevaluatedProperties: false,
      }),
    ).toEqual({
      type: "object",
      properties: {
        value: { anyOf: [{ type: "string" }, { type: "integer" }] },
      },
    })
  })

  test("widens heterogeneous tuples without narrowing item types", () => {
    expect(
      MFJS.sanitize({
        type: "object",
        properties: {
          values: {
            type: "array",
            items: [{ type: "string" }, { type: "number" }],
          },
        },
      }),
    ).toEqual({
      type: "object",
      properties: {
        values: {
          type: "array",
          items: { anyOf: [{ type: "string" }, { type: "number" }] },
        },
      },
    })
  })

  test("collapses homogeneous tuple items", () => {
    expect(
      MFJS.sanitize({
        type: "object",
        properties: {
          values: {
            type: "array",
            items: [{ type: "number" }, { type: "number" }],
            minItems: 2,
            maxItems: 2,
          },
        },
      }),
    ).toEqual({
      type: "object",
      properties: {
        values: {
          type: "array",
          items: { type: "number" },
          minItems: 2,
          maxItems: 2,
        },
      },
    })
  })

  test("forces mixed root unions to an object parameter schema", () => {
    expect(
      MFJS.sanitize({
        anyOf: [{ type: "object", properties: { value: { type: "string" } } }, { type: "string" }],
      }),
    ).toEqual({ type: "object", properties: {} })
  })

  test("flattens allOf object schemas", () => {
    expect(
      MFJS.sanitize({
        allOf: [
          {
            type: "object",
            properties: { source: { type: "string" } },
            required: ["source"],
          },
          {
            type: "object",
            properties: { destination: { type: "string" } },
            required: ["destination"],
            additionalProperties: false,
          },
        ],
      }),
    ).toEqual({
      type: "object",
      properties: {
        source: { type: "string" },
        destination: { type: "string" },
      },
      required: ["source", "destination"],
      additionalProperties: false,
    })
  })

  test("normalizes draft-07 definitions and references", () => {
    expect(
      MFJS.sanitize({
        type: "object",
        properties: {
          operation: {
            $ref: "#/definitions/Operation",
            description: "Moonshot rejects siblings next to refs.",
          },
        },
        definitions: {
          Operation: { enum: ["move", "copy"] },
        },
      }),
    ).toEqual({
      type: "object",
      properties: { operation: { $ref: "#/$defs/Operation" } },
      $defs: {
        Operation: { type: "string", enum: ["move", "copy"] },
      },
    })
  })

  test("omits unreferenced definitions", () => {
    expect(
      MFJS.sanitize({
        type: "object",
        properties: { value: { type: "string" } },
        $defs: {
          Unused: { type: "object", properties: { ignored: { type: "string" } } },
        },
      }),
    ).toEqual({
      type: "object",
      properties: { value: { type: "string" } },
    })
  })

  test("drops references to missing definitions", () => {
    expect(
      MFJS.sanitize({
        type: "object",
        properties: { operation: { $ref: "#/$defs/Missing" } },
      }),
    ).toEqual({
      type: "object",
      properties: { operation: { type: "string" } },
    })
  })

  test("keeps only valid MFJS ranges", () => {
    expect(
      MFJS.sanitize({
        type: "object",
        properties: {
          score: { type: "number", exclusiveMinimum: -1, exclusiveMaximum: 1 },
          count: { type: "integer", exclusiveMinimum: -1, exclusiveMaximum: 3 },
          label: { type: "string", minLength: 5, maxLength: 2 },
          list: { type: "array", minItems: -1, maxItems: 3 },
        },
      }),
    ).toEqual({
      type: "object",
      properties: {
        score: { type: "number" },
        count: { type: "integer", minimum: 0, maximum: 2 },
        label: { type: "string" },
        list: { type: "array", maxItems: 3 },
      },
    })
  })

  test("preserves unconstrained child schemas", () => {
    expect(
      MFJS.sanitize({
        type: "object",
        properties: {
          empty: {},
          truthy: true,
          falsy: false,
        },
      }),
    ).toEqual({
      type: "object",
      properties: {
        empty: {},
        truthy: {},
        falsy: {},
      },
    })
  })

  test("removes empty property names and references to filtered definitions", () => {
    expect(
      MFJS.sanitize({
        type: "object",
        properties: {
          "": { type: "string" },
          value: { $ref: "#/$defs/Bad~1Name" },
        },
        required: ["", "value"],
        $defs: {
          "Bad/Name": { type: "object" },
        },
      }),
    ).toEqual({
      type: "object",
      properties: { value: {} },
      required: ["value"],
    })
  })

  test("makes required recursive roots terminable", () => {
    expect(
      MFJS.sanitize({
        type: "object",
        properties: { node: { $ref: "#/$defs/Node" } },
        required: ["node"],
        $defs: {
          Node: {
            type: "object",
            properties: { next: { $ref: "#/$defs/Node" } },
            required: ["next"],
          },
        },
      }),
    ).toEqual({
      type: "object",
      properties: { node: { $ref: "#/$defs/Node" } },
      $defs: {
        Node: {
          type: "object",
          properties: { next: { $ref: "#/$defs/Node" } },
          required: ["next"],
        },
      },
    })
  })

  test("preserves nullable reference semantics", () => {
    expect(
      MFJS.sanitize({
        type: "object",
        properties: {
          value: { $ref: "#/$defs/Value", nullable: true },
        },
        $defs: {
          Value: { type: "object", properties: { label: { type: "string" } } },
        },
      }),
    ).toEqual({
      type: "object",
      properties: {
        value: { anyOf: [{ $ref: "#/$defs/Value" }, { type: "null" }] },
      },
      $defs: {
        Value: { type: "object", properties: { label: { type: "string" } } },
      },
    })
  })

  test("merges referenced object branches at the root", () => {
    expect(
      MFJS.sanitize({
        anyOf: [{ $ref: "#/$defs/Left" }, { $ref: "#/$defs/Right" }],
        $defs: {
          Left: { type: "object", properties: { left: { type: "string" } }, required: ["left"] },
          Right: { type: "object", properties: { right: { type: "number" } }, required: ["right"] },
        },
      }),
    ).toEqual({
      type: "object",
      properties: {
        left: { type: "string" },
        right: { type: "number" },
      },
      $defs: {
        Left: { type: "object", properties: { left: { type: "string" } }, required: ["left"] },
        Right: { type: "object", properties: { right: { type: "number" } }, required: ["right"] },
      },
    })
  })

  test("combines inclusive and exclusive integer bounds", () => {
    expect(
      MFJS.sanitize({
        type: "object",
        properties: {
          value: {
            type: "integer",
            minimum: 0,
            exclusiveMinimum: 5,
            maximum: 10,
            exclusiveMaximum: 8,
          },
        },
      }),
    ).toEqual({
      type: "object",
      properties: { value: { type: "integer", minimum: 6, maximum: 7 } },
    })
  })

  test("enforces Walle property and size limits", () => {
    const properties = Object.fromEntries(
      Array.from({ length: 3001 }, (_, index) => [`property_${index}`, { type: "string" }]),
    )
    const limited = asObject(MFJS.sanitize({ type: "object", properties }))

    expect(Object.keys(asObject(limited.properties))).toHaveLength(3000)
    expect(
      MFJS.sanitize({
        type: "object",
        description: "<".repeat(20_000),
        properties: {
          description: { type: "string" },
          default: { type: "string" },
        },
      }),
    ).toEqual({
      type: "object",
      properties: {
        description: { type: "string" },
        default: { type: "string" },
      },
    })
  })

  test("enforces Walle depth limits", () => {
    const deep = Array.from({ length: 35 }).reduce<Record<string, unknown>>(
      (schema) => ({ type: "object", properties: { next: schema }, required: ["next"] }),
      { type: "string" },
    )

    expect(JSON.stringify(MFJS.sanitize(deep)).match(/properties/g)?.length).toBe(30)
  })

  test("enforces depth limits across references", () => {
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
        operation: { type: ["string", "null"], enum: ["move", null] },
        values: { type: "array", items: [{ type: "string" }, { type: "number" }] },
      },
      definitions: {
        Metadata: { type: "object", properties: { label: { type: "string", format: "uri" } } },
      },
    })

    expect(MFJS.sanitize(once)).toEqual(once)
  })
})
