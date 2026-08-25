import { describe, expect } from "bun:test"
import { Agent } from "@opencode-ai/core/agent"
import { ToolInputRepairPlugin } from "@opencode-ai/core/plugin/tool-input-repair"
import { Session } from "@opencode-ai/core/session"
import { SessionMessage } from "@opencode-ai/core/session/message"
import type { ToolHooks } from "@opencode-ai/plugin/effect/tool"
import { Tool } from "@opencode-ai/schema/tool"
import { Effect } from "effect"
import { it } from "../lib/effect"
import { host } from "./host"

function run(input: unknown, inputSchema: ToolHooks["execute.before"]["inputSchema"]) {
  const event: ToolHooks["execute.before"] = {
    tool: "test",
    input,
    inputSchema,
    sessionID: Session.ID.make("ses_repair"),
    agent: Agent.ID.make("build"),
    messageID: SessionMessage.ID.make("msg_repair"),
    id: Tool.CallID.make("call_repair"),
  }
  const events: ToolHooks = {
    "execute.before": event,
    "execute.after": { ...event, status: "error", error: new Tool.Error({ message: "unused" }) },
  }
  const base = host()
  return ToolInputRepairPlugin.Plugin.effect(
    host({
      tool: {
        ...base.tool,
        hook: (name, callback) => callback(events[name]).pipe(Effect.orDie, Effect.as({ dispose: Effect.void })),
      },
    }),
  ).pipe(Effect.as(event))
}

const object = (properties: Record<string, unknown>, required?: string[]) => ({
  type: "object" as const,
  properties,
  ...(required ? { required } : {}),
})

describe("tool input repair plugin", () => {
  it.effect("preserves valid input identity and unknown properties", () =>
    Effect.gen(function* () {
      const input = { count: 2, nested: { enabled: true }, extra: "keep" }
      const event = yield* run(
        input,
        object({ count: { type: "integer" }, nested: object({ enabled: { type: "boolean" } }) }),
      )
      expect(event.input).toBe(input)
      expect(event.input).toEqual(input)
    }),
  )

  it.effect("parses stringified root objects and repairs their fields", () =>
    Effect.gen(function* () {
      const schema = object({ count: { type: "integer" } })

      expect((yield* run('{"count":"2"}', schema)).input).toEqual({ count: 2 })
      expect((yield* run("{broken", schema)).input).toBe("{broken")
      expect((yield* run("[]", schema)).input).toBe("[]")
      expect((yield* run(null, schema)).input).toBeNull()
    }),
  )

  it.effect("removes unknown properties only from explicitly closed objects", () =>
    Effect.gen(function* () {
      const input = {
        known: "2",
        extra: true,
        closed: { keep: "3", extra: true },
        open: { keep: "4", extra: true },
        items: [{ keep: "5", extra: true }],
      }
      const event = yield* run(input, {
        ...object({
          known: { type: "integer" },
          closed: { ...object({ keep: { type: "integer" } }), additionalProperties: false },
          open: object({ keep: { type: "integer" } }),
          items: {
            type: "array",
            items: { ...object({ keep: { type: "integer" } }), additionalProperties: false },
          },
        }),
        additionalProperties: false,
      })

      expect(event.input).toEqual({
        known: 2,
        closed: { keep: 3 },
        open: { keep: 4, extra: true },
        items: [{ keep: 5 }],
      })
      expect(input.extra).toBeTrue()
      expect(input.closed.extra).toBeTrue()
      expect(input.items[0]?.extra).toBeTrue()

      const empty = yield* run({ extra: true }, { ...object({}), additionalProperties: false })
      expect(empty.input).toEqual({})
    }),
  )

  it.effect("preserves unknown properties allowed by open or dynamic schemas", () =>
    Effect.gen(function* () {
      const input = { known: 1, extra: true }
      const properties = { known: { type: "integer" } }
      const schemas = [
        object(properties),
        { ...object(properties), additionalProperties: true },
        { ...object(properties), additionalProperties: { type: "boolean" } },
        { ...object(properties), additionalProperties: false, patternProperties: { "^extra$": { type: "boolean" } } },
        { ...object(properties), additionalProperties: false, allOf: [{ properties: { extra: { type: "boolean" } } }] },
        { ...object(properties), additionalProperties: false, $ref: "#/$defs/example" },
      ]

      for (const schema of schemas) expect((yield* run(input, schema)).input).toBe(input)
    }),
  )

  it.effect("removes only optional nulls that explicitly exclude null", () =>
    Effect.gen(function* () {
      const event = yield* run(
        { optional: null, required: null, nullable: null, union: null, unknown: null },
        object(
          {
            optional: { type: "string" },
            required: { type: "string" },
            nullable: { type: "string", nullable: true },
            union: { type: ["string", "null"] },
            unknown: {},
          },
          ["required"],
        ),
      )
      expect(event.input).toEqual({ required: null, nullable: null, union: null, unknown: null })
    }),
  )

  it.effect("removes empty object placeholders only from optional non-object fields", () =>
    Effect.gen(function* () {
      const input = {
        optional: {},
        array: {},
        required: {},
        object: {},
        populated: { value: 1 },
        union: {},
        unknown: {},
      }
      const event = yield* run(
        input,
        object(
          {
            optional: { type: "integer" },
            array: { type: "array", items: { type: "string" } },
            required: { type: "boolean" },
            object: { type: "object" },
            populated: { type: "string" },
            union: { type: "string", anyOf: [{ type: "string" }, { type: "object" }] },
            unknown: {},
          },
          ["required"],
        ),
      )

      expect(event.input).toEqual({ required: {}, object: {}, populated: { value: 1 }, union: {}, unknown: {} })
      expect(input.optional).toEqual({})
      expect(input.array).toEqual({})
    }),
  )

  it.effect("coerces valid numeric and boolean strings without changing invalid candidates", () =>
    Effect.gen(function* () {
      const event = yield* run(
        {
          number: "1.5",
          integer: "42",
          enabled: "true",
          disabled: "false",
          empty: " ",
          infinite: "Infinity",
          fractional: "1.5",
          unsafe: "9007199254740992",
          uppercase: "TRUE",
        },
        object({
          number: { type: "number" },
          integer: { type: "integer" },
          enabled: { type: "boolean" },
          disabled: { type: "boolean" },
          empty: { type: "number" },
          infinite: { type: "number" },
          fractional: { type: "integer" },
          unsafe: { type: "integer" },
          uppercase: { type: "boolean" },
        }),
      )
      expect(event.input).toEqual({
        number: 1.5,
        integer: 42,
        enabled: true,
        disabled: false,
        empty: " ",
        infinite: "Infinity",
        fractional: "1.5",
        unsafe: "9007199254740992",
        uppercase: "TRUE",
      })
    }),
  )

  it.effect("parses only explicitly expected stringified containers", () =>
    Effect.gen(function* () {
      const event = yield* run(
        { list: '["a","b"]', item: '{"count":"2"}', invalid: "{broken", mismatch: '"text"' },
        object({
          list: { type: "array", items: { type: "string" } },
          item: object({ count: { type: "integer" } }),
          invalid: object({ value: { type: "string" } }),
          mismatch: object({ value: { type: "string" } }),
        }),
      )
      expect(event.input).toEqual({
        list: ["a", "b"],
        item: { count: 2 },
        invalid: "{broken",
        mismatch: '"text"',
      })
    }),
  )

  it.effect("wraps only values that clearly match array items", () =>
    Effect.gen(function* () {
      const event = yield* run(
        {
          text: "one",
          number: 2,
          integer: "42",
          boolean: "false",
          item: { name: "one" },
          stringified: '{"count":"2"}',
          incompatible: 2,
          fractional: 1.5,
        },
        object({
          text: { type: "array", items: { type: "string" } },
          number: { type: "array", items: { type: "number" } },
          integer: { type: "array", items: { type: "integer" } },
          boolean: { type: "array", items: { type: "boolean" } },
          item: { type: "array", items: object({ name: { type: "string" } }) },
          stringified: { type: "array", items: object({ count: { type: "integer" } }) },
          incompatible: { type: "array", items: { type: "string" } },
          fractional: { type: "array", items: { type: "integer" } },
        }),
      )
      expect(event.input).toEqual({
        text: ["one"],
        number: [2],
        integer: [42],
        boolean: [false],
        item: [{ name: "one" }],
        stringified: [{ count: 2 }],
        incompatible: 2,
        fractional: 1.5,
      })
    }),
  )

  it.effect("repairs nested question-like fields without mutating original containers", () =>
    Effect.gen(function* () {
      const question = { question: "Pick one", multiple: "false", options: { label: "First", description: null } }
      const input = { questions: [question] }
      const event = yield* run(
        input,
        object({
          questions: {
            type: "array",
            items: object({
              question: { type: "string" },
              multiple: { type: "boolean" },
              options: {
                type: "array",
                items: object({ label: { type: "string" }, description: { type: "string" } }, ["label"]),
              },
            }),
          },
        }),
      )
      expect(event.input).toEqual({
        questions: [{ question: "Pick one", multiple: false, options: [{ label: "First" }] }],
      })
      expect(input).toEqual({ questions: [question] })
      expect(question).toEqual({
        question: "Pick one",
        multiple: "false",
        options: { label: "First", description: null },
      })
      expect(event.input).not.toBe(input)
    }),
  )

  it.effect("preserves values already accepted by primitive unions", () =>
    Effect.gen(function* () {
      const input = { numberText: "2", number: 2, booleanText: "true", boolean: true, parent: "3" }
      const event = yield* run(
        input,
        object({
          numberText: { anyOf: [{ type: "string" }, { type: "number" }] },
          number: { oneOf: [{ type: "string" }, { type: "number" }] },
          booleanText: { anyOf: [{ type: "string" }, { type: "boolean" }] },
          boolean: { oneOf: [{ type: "string" }, { type: "boolean" }] },
          parent: { type: "number", anyOf: [{ type: "number" }, { type: "string" }] },
        }),
      )

      expect(event.input).toEqual({ ...input, parent: 3 })
      expect(input.parent).toBe("3")
    }),
  )

  it.effect("preserves values accepted by unconstrained union branches and structural literals", () =>
    Effect.gen(function* () {
      const constant = { nested: [1, { enabled: true }] }
      const enumerated = ["first", { count: 2 }]
      const input = {
        emptyAny: "2",
        trueAny: "3",
        emptyOne: "4",
        trueOne: "5",
        constant,
        enumerated,
      }
      const event = yield* run(
        input,
        object({
          emptyAny: { anyOf: [{ type: "number" }, {}] },
          trueAny: { anyOf: [{ type: "number" }, true] },
          emptyOne: { oneOf: [{ type: "number" }, {}] },
          trueOne: { oneOf: [{ type: "number" }, true] },
          constant: { anyOf: [{ const: { nested: [1, { enabled: true }] } }, { type: "string" }] },
          enumerated: { oneOf: [{ enum: [["first", { count: 2 }]] }, { type: "string" }] },
        }),
      )

      expect(event.input).toBe(input)
      expect((event.input as typeof input).constant).toBe(constant)
      expect((event.input as typeof input).enumerated).toBe(enumerated)
    }),
  )

  it.effect("intersects parent types and jointly applies anyOf and oneOf alternatives", () =>
    Effect.gen(function* () {
      const event = yield* run(
        { any: "2", one: "3", both: "4", nullable: null },
        object({
          any: { type: "number", anyOf: [{ type: "string" }, { type: "number" }] },
          one: { type: "integer", oneOf: [{ type: "string" }, { type: "integer" }] },
          both: {
            anyOf: [{ type: "string" }, { type: "integer" }],
            oneOf: [{ type: "integer" }, { type: "boolean" }],
          },
          nullable: { type: "number", nullable: true, anyOf: [{ type: "number" }, { type: "null" }] },
        }),
      )

      expect(event.input).toEqual({ any: 2, one: 3, both: 4, nullable: null })
    }),
  )

  it.effect("repairs numeric unions while preserving explicitly accepted strings", () =>
    Effect.gen(function* () {
      const event = yield* run(
        { minimum: "2", maximum: "8", exclusiveMinimum: "3", exclusiveMaximum: "7", pattern: "42" },
        object({
          minimum: {
            anyOf: [
              { type: "number", minimum: 5 },
              { type: "integer", maximum: 3 },
            ],
          },
          maximum: {
            oneOf: [
              { type: "number", maximum: 5 },
              { type: "integer", minimum: 7 },
            ],
          },
          exclusiveMinimum: {
            anyOf: [
              { type: "number", exclusiveMinimum: 3 },
              { type: "integer", maximum: 3 },
            ],
          },
          exclusiveMaximum: {
            oneOf: [
              { type: "number", exclusiveMaximum: 7 },
              { type: "integer", minimum: 7 },
            ],
          },
          pattern: { anyOf: [{ type: "string", pattern: "^[a-z]+$" }, { type: "integer" }] },
        }),
      )

      expect(event.input).toEqual({ minimum: 2, maximum: 8, exclusiveMinimum: 3, exclusiveMaximum: 7, pattern: "42" })
    }),
  )

  it.effect("repairs uniquely coercible nullable and type-array unions", () =>
    Effect.gen(function* () {
      const event = yield* run(
        { number: "2", boolean: "false", nullable: null, typed: "3", typedBoolean: "true", preserved: "4" },
        object({
          number: { anyOf: [{ type: "number" }, { type: "null" }] },
          boolean: { oneOf: [{ type: "boolean" }, { type: "null" }] },
          nullable: { anyOf: [{ type: "number" }, { type: "null" }] },
          typed: { type: ["integer", "null"] },
          typedBoolean: { type: ["boolean", "null"] },
          preserved: { type: ["number", "string"] },
        }),
      )

      expect(event.input).toEqual({
        number: 2,
        boolean: false,
        nullable: null,
        typed: 3,
        typedBoolean: true,
        preserved: "4",
      })
    }),
  )

  it.effect("repairs uniquely tagged or required object alternatives", () =>
    Effect.gen(function* () {
      const tagged = { kind: "count", value: "2" }
      const required = { enabled: "false" }
      const input = { tagged, required }
      const event = yield* run(
        input,
        object({
          tagged: {
            anyOf: [
              object({ kind: { const: "count" }, value: { type: "integer" } }, ["kind", "value"]),
              object({ kind: { enum: ["flag"] }, value: { type: "boolean" } }, ["kind", "value"]),
            ],
          },
          required: {
            oneOf: [
              object({ enabled: { type: "boolean" } }, ["enabled"]),
              object({ count: { type: "integer" } }, ["count"]),
            ],
          },
        }),
      )

      expect(event.input).toEqual({ tagged: { kind: "count", value: 2 }, required: { enabled: false } })
      expect(input.tagged).toBe(tagged)
      expect(tagged.value).toBe("2")
      expect(required.enabled).toBe("false")
    }),
  )

  it.effect("composes root object properties with their selected alternative", () =>
    Effect.gen(function* () {
      const input = { shared: "3", kind: "count", value: "2" }
      const event = yield* run(input, {
        ...object({ shared: { type: "integer" } }),
        anyOf: [
          object({ kind: { const: "count" }, value: { type: "integer" } }, ["kind", "value"]),
          object({ kind: { const: "flag" }, value: { type: "boolean" } }, ["kind", "value"]),
        ],
      })

      expect(event.input).toEqual({ shared: 3, kind: "count", value: 2 })
      expect(input).toEqual({ shared: "3", kind: "count", value: "2" })
    }),
  )

  it.effect("applies all intersection members without removing ambiguously owned fields", () =>
    Effect.gen(function* () {
      const event = yield* run(
        { number: "2", details: { count: "3", enabled: "false", extra: true } },
        object({
          number: { allOf: [{ type: "number" }, { type: "integer" }] },
          details: {
            ...object({ count: { type: "integer" } }),
            additionalProperties: false,
            allOf: [{ ...object({ enabled: { type: "boolean" } }), additionalProperties: false }],
          },
        }),
      )

      expect(event.input).toEqual({ number: 2, details: { count: 3, enabled: false, extra: true } })
    }),
  )

  it.effect("repairs positional and rest tuple items without changing valid identity", () =>
    Effect.gen(function* () {
      const valid = [2, false]
      const input = {
        prefix: ["2", "false", "3", "4"],
        draft: ["5", "true", "untouched"],
        valid,
        unknown: ["6", "unchanged"],
      }
      const event = yield* run(
        input,
        object({
          prefix: {
            type: "array",
            prefixItems: [{ type: "integer" }, { type: "boolean" }],
            items: { type: "number" },
          },
          draft: { type: "array", items: [{ type: "integer" }, { type: "boolean" }] },
          valid: { type: "array", prefixItems: [{ type: "integer" }, { type: "boolean" }] },
          unknown: { type: "array", prefixItems: [{ type: "integer" }] },
        }),
      )

      expect(event.input).toEqual({
        prefix: [2, false, 3, 4],
        draft: [5, true, "untouched"],
        valid: [2, false],
        unknown: [6, "unchanged"],
      })
      expect((event.input as typeof input).valid).toBe(valid)
      expect(input.prefix).toEqual(["2", "false", "3", "4"])
      expect(input.draft).toEqual(["5", "true", "untouched"])
    }),
  )

  it.effect("parses stringified tuples but never wraps tuple scalars", () =>
    Effect.gen(function* () {
      const event = yield* run(
        { prefix: '["2","false"]', draft: '["3","true"]', scalar: "4", legacyScalar: "5" },
        object({
          prefix: { type: "array", prefixItems: [{ type: "integer" }, { type: "boolean" }] },
          draft: { type: "array", items: [{ type: "integer" }, { type: "boolean" }] },
          scalar: { type: "array", prefixItems: [{ type: "integer" }] },
          legacyScalar: { type: "array", items: [{ type: "integer" }] },
        }),
      )

      expect(event.input).toEqual({ prefix: [2, false], draft: [3, true], scalar: "4", legacyScalar: "5" })
    }),
  )

  it.effect("repairs declared and dictionary values without deleting dictionary entries", () =>
    Effect.gen(function* () {
      const mixed = { enabled: "true", first: "2", empty: {}, missing: null }
      const dictionary = { first: "3", second: "4" }
      const input = { mixed, dictionary }
      const event = yield* run(
        input,
        object({
          mixed: {
            ...object({ enabled: { type: "boolean" } }),
            additionalProperties: { type: "integer" },
          },
          dictionary: { type: "object", additionalProperties: { type: "number" } },
        }),
      )

      expect(event.input).toEqual({
        mixed: { enabled: true, first: 2, empty: {}, missing: null },
        dictionary: { first: 3, second: 4 },
      })
      expect(mixed).toEqual({ enabled: "true", first: "2", empty: {}, missing: null })
      expect(dictionary).toEqual({ first: "3", second: "4" })
    }),
  )

  it.effect("leaves dictionary values untouched when property ownership is ambiguous", () =>
    Effect.gen(function* () {
      const input = { patterned: { value: "2" }, referenced: { value: "3" }, composed: { value: "4" } }
      const event = yield* run(
        input,
        object({
          patterned: {
            type: "object",
            additionalProperties: { type: "number" },
            patternProperties: { "^value$": { type: "string" } },
          },
          referenced: { type: "object", additionalProperties: { type: "number" }, $ref: "#/$defs/example" },
          composed: { type: "object", additionalProperties: { type: "number" }, allOf: [{}] },
        }),
      )

      expect(event.input).toBe(input)
    }),
  )

  it.effect("repairs matching pattern properties and removes unmatched closed-object keys", () =>
    Effect.gen(function* () {
      const input = { count_first: "2", flag_ready: "false", extra: true }
      const event = yield* run(input, {
        type: "object",
        patternProperties: { "^count_": { type: "integer" }, "^flag_": { type: "boolean" } },
        additionalProperties: false,
      })

      expect(event.input).toEqual({ count_first: 2, flag_ready: false })
      expect(input).toEqual({ count_first: "2", flag_ready: "false", extra: true })
    }),
  )

  it.effect("preserves values claimed by overlapping pattern schemas", () =>
    Effect.gen(function* () {
      const input = { value: "2" }
      const event = yield* run(input, {
        type: "object",
        patternProperties: { "^val": { type: "integer" }, ue$: { type: "number" } },
        additionalProperties: false,
      })

      expect(event.input).toBe(input)
    }),
  )

  it.effect("recursively repairs arrays and tuples selected from nullable unions", () =>
    Effect.gen(function* () {
      const input = { array: '[{"count":"2"}]', tuple: '["3","false"]', nullable: null }
      const event = yield* run(
        input,
        object({
          array: { anyOf: [{ type: "array", items: object({ count: { type: "integer" } }) }, { type: "null" }] },
          tuple: {
            oneOf: [{ type: "array", prefixItems: [{ type: "integer" }, { type: "boolean" }] }, { type: "null" }],
          },
          nullable: { anyOf: [{ type: "array", items: { type: "integer" } }, { type: "null" }] },
        }),
      )

      expect(event.input).toEqual({ array: [{ count: 2 }], tuple: [3, false], nullable: null })
      expect(input.array).toBe('[{"count":"2"}]')
    }),
  )

  it.effect("selects object alternatives using multi-value enum discriminators and closed ownership", () =>
    Effect.gen(function* () {
      const event = yield* run(
        { tagged: { kind: "total", value: "2" }, closed: { count: "3", extra: true } },
        object({
          tagged: {
            anyOf: [
              object({ kind: { enum: ["count", "total"] }, value: { type: "integer" } }, ["kind", "value"]),
              object({ kind: { enum: ["flag", "switch"] }, value: { type: "boolean" } }, ["kind", "value"]),
            ],
          },
          closed: {
            oneOf: [
              { ...object({ enabled: { type: "boolean" } }), additionalProperties: false },
              { ...object({ count: { type: "integer" } }), additionalProperties: false },
            ],
          },
        }),
      )

      expect(event.input).toEqual({ tagged: { kind: "total", value: 2 }, closed: { count: 3 } })
    }),
  )

  it.effect("resolves local definitions across nested objects, tuples, and additional properties", () =>
    Effect.gen(function* () {
      const input = {
        modern: "2",
        legacy: "false",
        nested: { count: "3" },
        tuple: ["4", "true"],
        dictionary: { first: "5" },
        escaped: "6",
      }
      const event = yield* run(input, {
        ...object({
          modern: { $ref: "#/$defs/integer" },
          legacy: { $ref: "#/definitions/boolean" },
          nested: { $ref: "#/$defs/nested" },
          tuple: {
            type: "array",
            prefixItems: [{ $ref: "#/$defs/integer" }, { $ref: "#/definitions/boolean" }],
          },
          dictionary: { type: "object", additionalProperties: { $ref: "#/$defs/integer" } },
          escaped: { $ref: "#/$defs/slash~1and~0tilde" },
        }),
        $defs: {
          integer: { type: "integer" },
          nested: object({ count: { $ref: "#/$defs/integer" } }),
          "slash/and~tilde": { type: "integer" },
        },
        definitions: { boolean: { type: "boolean" } },
      })

      expect(event.input).toEqual({
        modern: 2,
        legacy: false,
        nested: { count: 3 },
        tuple: [4, true],
        dictionary: { first: 5 },
        escaped: 6,
      })
      expect(input.nested.count).toBe("3")
      expect(input.tuple).toEqual(["4", "true"])
      expect(input.dictionary.first).toBe("5")
    }),
  )

  it.effect("bounds recursive references and preserves unresolved or external references", () =>
    Effect.gen(function* () {
      const input = {
        recursive: { value: "2", next: { value: "3" } },
        cyclic: "4",
        unresolved: "5",
        external: "6",
      }
      const event = yield* run(input, {
        ...object({
          recursive: { $ref: "#/$defs/node" },
          cyclic: { $ref: "#/$defs/cyclic" },
          unresolved: { $ref: "#/$defs/missing" },
          external: { $ref: "other-schema.json#/$defs/integer" },
        }),
        $defs: {
          node: object({ value: { type: "integer" }, next: { $ref: "#/$defs/node" } }),
          cyclic: { $ref: "#/$defs/cyclic" },
        },
      })

      expect(event.input).toEqual({
        recursive: { value: 2, next: { value: 3 } },
        cyclic: "4",
        unresolved: "5",
        external: "6",
      })
      expect(input.recursive).toEqual({ value: "2", next: { value: "3" } })
    }),
  )

  it.effect("repairs typeless and composed root schemas when their shape is unambiguous", () =>
    Effect.gen(function* () {
      expect((yield* run({ count: "2" }, { properties: { count: { type: "integer" } } })).input).toEqual({ count: 2 })
      expect((yield* run({ count: "3" }, { allOf: [object({ count: { type: "integer" } })] })).input).toEqual({
        count: 3,
      })
      expect(
        (yield* run(
          { kind: "count", value: "4" },
          {
            anyOf: [
              object({ kind: { const: "count" }, value: { type: "integer" } }, ["kind", "value"]),
              object({ kind: { const: "flag" }, value: { type: "boolean" } }, ["kind", "value"]),
            ],
          },
        )).input,
      ).toEqual({ kind: "count", value: 4 })
      expect(
        (yield* run(
          { enabled: "false" },
          {
            oneOf: [
              object({ enabled: { type: "boolean" } }, ["enabled"]),
              object({ count: { type: "integer" } }, ["count"]),
            ],
          },
        )).input,
      ).toEqual({ enabled: false })
      expect(
        (yield* run({ count: "5" }, { $ref: "#/$defs/root", $defs: { root: object({ count: { type: "integer" } }) } }))
          .input,
      ).toEqual({ count: 5 })
    }),
  )

  it.effect("removes extras from closed objects even without declared properties", () =>
    Effect.gen(function* () {
      const input = { typed: { extra: true }, typeless: { extra: true } }
      const event = yield* run(
        input,
        object({
          typed: { type: "object", additionalProperties: false },
          typeless: { additionalProperties: false },
        }),
      )

      expect(event.input).toEqual({ typed: {}, typeless: {} })
      expect(input).toEqual({ typed: { extra: true }, typeless: { extra: true } })
    }),
  )

  it.effect("parses unconstrained arrays without wrapping scalars that lack item evidence", () =>
    Effect.gen(function* () {
      const event = yield* run(
        { omitted: '[1,"two"]', allowed: '[2,"three"]', omittedScalar: "4", allowedScalar: "5" },
        object({
          omitted: { type: "array" },
          allowed: { type: "array", items: true },
          omittedScalar: { type: "array" },
          allowedScalar: { type: "array", items: true },
        }),
      )

      expect(event.input).toEqual({
        omitted: [1, "two"],
        allowed: [2, "three"],
        omittedScalar: "4",
        allowedScalar: "5",
      })
    }),
  )

  it.effect("repairs draft tuple rest values using additionalItems schemas", () =>
    Effect.gen(function* () {
      const input = { tuple: ["2", "false", "3", "4"] }
      const event = yield* run(
        input,
        object({
          tuple: {
            type: "array",
            items: [{ type: "integer" }, { type: "boolean" }],
            additionalItems: { type: "number" },
          },
        }),
      )

      expect(event.input).toEqual({ tuple: [2, false, 3, 4] })
      expect(input.tuple).toEqual(["2", "false", "3", "4"])
    }),
  )

  it.effect("removes optional nulls from nonnullable unions while preserving nullable alternatives", () =>
    Effect.gen(function* () {
      const event = yield* run(
        { any: null, one: null, allowedAny: null, allowedOne: null, nullable: null, constrained: null },
        object({
          any: { anyOf: [{ type: "string" }, { type: "integer" }] },
          one: { oneOf: [{ type: "string" }, { type: "boolean" }] },
          allowedAny: { anyOf: [{ type: "string" }, { type: "null" }] },
          allowedOne: { oneOf: [{ type: "boolean" }, { type: "null" }] },
          nullable: { type: "string", nullable: true },
          constrained: { nullable: true, anyOf: [{ type: "string" }, { type: "integer" }] },
        }),
      )

      expect(event.input).toEqual({ allowedAny: null, allowedOne: null, nullable: null })
    }),
  )

  it.effect("does not treat inherited prototype names as required object properties", () =>
    Effect.gen(function* () {
      const input = { value: "2" }
      const event = yield* run(input, {
        oneOf: [
          object({ constructor: { type: "string" }, value: { type: "boolean" } }, ["constructor"]),
          object({ toString: { type: "string" }, value: { type: "boolean" } }, ["toString"]),
          object({ value: { type: "integer" } }, ["value"]),
        ],
      })

      expect(event.input).toEqual({ value: 2 })
      expect(input.value).toBe("2")
    }),
  )

  it.effect("repairs alternatives nested in allOf without resolving ambiguous oneOf branches", () =>
    Effect.gen(function* () {
      const ambiguous = { value: "4" }
      const event = yield* run(
        { tagged: { kind: "count", value: "2" }, required: { enabled: "false" }, ambiguous },
        object({
          tagged: {
            anyOf: [
              { allOf: [object({ kind: { const: "count" }, value: { type: "integer" } }, ["kind", "value"])] },
              { allOf: [object({ kind: { const: "flag" }, value: { type: "boolean" } }, ["kind", "value"])] },
            ],
          },
          required: {
            oneOf: [
              { allOf: [object({ enabled: { type: "boolean" } }, ["enabled"])] },
              { allOf: [object({ count: { type: "integer" } }, ["count"])] },
            ],
          },
          ambiguous: {
            oneOf: [
              { allOf: [object({ value: { type: "integer" } }, ["value"])] },
              { allOf: [object({ value: { type: "number" } }, ["value"])] },
            ],
          },
        }),
      )

      expect(event.input).toEqual({ tagged: { kind: "count", value: 2 }, required: { enabled: false }, ambiguous })
      expect((event.input as { ambiguous: typeof ambiguous }).ambiguous).toBe(ambiguous)
      expect(ambiguous.value).toBe("4")
    }),
  )

  it.effect("skips ambiguous unions and unsupported schemas", () =>
    Effect.gen(function* () {
      const input = { numeric: "2", objects: { value: "3" }, unknown: "4" }
      const event = yield* run(
        input,
        object({
          numeric: { anyOf: [{ type: "number" }, { type: "integer" }] },
          objects: {
            oneOf: [
              object({ value: { type: "integer" } }, ["value"]),
              object({ value: { type: "number" } }, ["value"]),
            ],
          },
          unknown: {},
        }),
      )

      expect(event.input).toBe(input)
    }),
  )
})
