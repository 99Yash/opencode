import type { Tool } from "@opencode-ai/schema/tool"
import { Schema, SchemaAST } from "effect"
import type { Context } from "./plugin.js"

export function instanceSafeContext(context: Context): Context {
  return {
    ...context,
    tool: {
      ...context.tool,
      transform: (callback) =>
        context.tool.transform((draft) => callback({ add: (tool) => draft.add(instanceSafeTool(tool)) })),
    },
  }
}

export function instanceSafeTool(tool: Tool.Info<any, any>): Tool.Info<any, any> {
  const input = instanceSafeValueSchema(tool.input, "input")
  const output = tool.output === undefined ? undefined : instanceSafeValueSchema(tool.output, "output")
  if (input === tool.input && output === tool.output) return tool
  return { ...tool, input, ...(output === undefined ? {} : { output }) }
}

function instanceSafeValueSchema(schema: Tool.ValueSchema<any>, direction: "input" | "output"): Tool.ValueSchema<any> {
  if (typeof schema === "object" && schema !== null && "~standard" in schema) {
    const standard = schema["~standard"] as Record<string, any>
    if (
      typeof standard.validate !== "function" ||
      typeof standard.jsonSchema?.input !== "function" ||
      typeof standard.jsonSchema?.output !== "function"
    )
      throw new Error("Tool schemas must implement Standard Schema validation and JSON Schema generation")
    return { "~standard": standard } as Tool.ValueSchema<any>
  }
  if (!Schema.isSchema(schema)) return schema
  // Native codecs can only be compiled by the Effect instance that authored their AST.
  if (!(schema.ast instanceof SchemaAST.Base)) {
    throw new Error(
      "Effect tool schemas must use Schema from @opencode-ai/plugin/effect or be converted to Standard Schema by their authoring Effect instance",
    )
  }
  const codec = schema as Schema.Codec<unknown, unknown>
  // Standard Schema validates Encoded -> Type, so flip outputs to run Type -> Encoded.
  const oriented = direction === "input" ? codec : Schema.flip(codec)
  const augmented = Schema.toStandardJSONSchemaV1(Schema.toStandardSchemaV1(oriented)) as unknown as {
    readonly "~standard": Record<string, unknown>
  }
  return { "~standard": augmented["~standard"] } as Tool.ValueSchema<any>
}
