import type { Tool } from "@opencode-ai/schema/tool"
import { Schema, SchemaAST } from "effect"

export function toStandardSchema(schema: Tool.ValueSchema<any>, direction: "input" | "output"): Tool.ValueSchema<any> {
  if (typeof schema === "object" && schema !== null && "~standard" in schema) {
    return { "~standard": schema["~standard"] } as Tool.ValueSchema<any>
  }
  if (!Schema.isSchema(schema)) return schema
  if (!(schema.ast instanceof SchemaAST.Base)) {
    throw new Error(
      "Effect tool schemas must use the plugin's Effect peer or be converted to Standard Schema by their authoring runtime",
    )
  }
  const codec = schema as Schema.Codec<unknown, unknown>
  const oriented = direction === "input" ? codec : Schema.flip(codec)
  const standard = Schema.toStandardJSONSchemaV1(Schema.toStandardSchemaV1(oriented))
  return { "~standard": standard["~standard"] } as Tool.ValueSchema<any>
}
