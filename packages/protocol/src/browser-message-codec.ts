export * as BrowserMessageCodec from "./browser-message-codec.js"

import { Effect, Schema } from "effect"

const encoder = new TextEncoder()
const decoder = new TextDecoder("utf-8", { fatal: true })

export function make<
  const Name extends string,
  const Client extends Schema.ConstraintCodec<unknown, unknown>,
  const Server extends Schema.ConstraintCodec<unknown, unknown>,
>(options: {
  readonly name: Name
  readonly label: string
  readonly maxBytes: number
  readonly fromClient: Client
  readonly fromServer: Server
}) {
  class MessageError extends Schema.TaggedError<MessageError>()(`${options.name}.MessageError` as const, {
    kind: Schema.Literals(["invalid", "too_large"]),
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  }) {}

  const encodeClient = Schema.encodeSync(Schema.fromJsonString(options.fromClient))
  const encodeServer = Schema.encodeSync(Schema.fromJsonString(options.fromServer))
  const decodeClient = Schema.decodeUnknownEffect(Schema.fromJsonString(options.fromClient), {
    errors: "all",
    onExcessProperty: "error",
  })
  const decodeServer = Schema.decodeUnknownEffect(Schema.fromJsonString(options.fromServer), {
    errors: "all",
    onExcessProperty: "error",
  })

  const encode = (input: string) => {
    if (encoder.encode(input).byteLength > options.maxBytes) {
      throw new RangeError(`${options.label} must not exceed ${options.maxBytes} bytes.`)
    }
    return input
  }

  const decode = <Message>(
    input: string | Uint8Array,
    decodeMessage: (input: unknown) => Effect.Effect<Message, unknown>,
  ): Effect.Effect<Message, MessageError> => {
    if ((typeof input === "string" ? encoder.encode(input).byteLength : input.byteLength) > options.maxBytes) {
      return Effect.fail(new MessageError({ kind: "too_large", message: `${options.label} is too large.` }))
    }
    return (
      typeof input === "string"
        ? Effect.succeed(input)
        : Effect.try({
            try: () => decoder.decode(input),
            catch: (cause) =>
              new MessageError({ kind: "invalid", message: `${options.label} is not valid UTF-8.`, cause }),
          })
    ).pipe(
      Effect.flatMap(decodeMessage),
      Effect.mapError((cause) =>
        cause instanceof MessageError
          ? cause
          : new MessageError({ kind: "invalid", message: `${options.label} is invalid.`, cause }),
      ),
    )
  }

  return {
    encodeFromClient: (input: Client["Type"]) => encode(encodeClient(input)),
    encodeFromServer: (input: Server["Type"]) => encode(encodeServer(input)),
    decodeFromClient: (input: string | Uint8Array) => decode(input, decodeClient),
    decodeFromServer: (input: string | Uint8Array) => decode(input, decodeServer),
  }
}
