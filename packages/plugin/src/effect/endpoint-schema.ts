import { Schema, SchemaAST } from "effect"
import { HttpApiEndpoint, HttpApiSchema } from "effect/unstable/httpapi"

type RuntimeSchema = Schema.Codec<unknown, unknown>

export function endpointSchemas(endpoint: HttpApiEndpoint.Top) {
  const payload = Array.from(endpoint.payload.values()).flatMap(({ schemas }) => schemas)
  const success = Array.from(endpoint.success)
  if (payload.length > 1 || success.length > 1) {
    throw new Error(`Unsupported API schema cardinality: ${endpoint.identifier}`)
  }
  const inputs = [
    endpoint.params,
    endpoint.query === undefined ? undefined : Schema.toType(endpoint.query),
    endpoint.headers,
    ...payload,
  ].filter((schema): schema is Schema.Top => schema !== undefined) as Array<RuntimeSchema>
  const output = (success[0] ?? HttpApiSchema.NoContent) as RuntimeSchema
  const type = Schema.toType(output).ast
  const data = SchemaAST.isObjects(output.ast)
    ? output.ast.propertySignatures.find((property) => property.name === "data")
    : undefined
  return {
    inputs,
    output:
      !HttpApiSchema.isNoContent(output.ast) &&
      SchemaAST.isObjects(type) &&
      type.indexSignatures.length === 0 &&
      type.propertySignatures.length === 1 &&
      type.propertySignatures[0]?.name === "data" &&
      data !== undefined
        ? (Schema.make<Schema.Top>(data.type) as RuntimeSchema)
        : output,
    noContent: HttpApiSchema.isNoContent(output.ast),
  }
}
