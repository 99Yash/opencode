export * as Image from "./image.js"

import { makeLocationNode } from "@opencode-ai/util/effect/app-node"
import { Context, Effect, Layer, Schema } from "effect"
import { FileSystem } from "./filesystem.js"
import type { DeepMutable } from "./schema.js"
import { State } from "./state.js"

export class ResizerUnavailableError extends Schema.TaggedError<ResizerUnavailableError>()(
  "Image.ResizerUnavailableError",
  {},
) {}

export class DecodeError extends Schema.TaggedError<DecodeError>()("Image.DecodeError", {
  resource: Schema.String,
}) {
  override get message() {
    return `Image could not be decoded: ${this.resource}`
  }
}

export class SizeError extends Schema.TaggedError<SizeError>()("Image.SizeError", {
  resource: Schema.String,
  width: Schema.Number,
  height: Schema.Number,
  bytes: Schema.Number,
  maxWidth: Schema.Number,
  maxHeight: Schema.Number,
  maxBytes: Schema.Number,
}) {
  override get message() {
    return `Image ${this.resource} is ${this.width}x${this.height} with base64 size ${this.bytes}, exceeding configured limits ${this.maxWidth}x${this.maxHeight}/${this.maxBytes} bytes`
  }
}

export interface Policy {
  readonly autoResize: boolean
  readonly maxWidth: number
  readonly maxHeight: number
  readonly maxBase64Bytes: number
}

export interface Draft {
  readonly update: (update: (policy: DeepMutable<Policy>) => void) => void
}

export interface Interface extends State.Transformable<Draft> {
  readonly normalize: (
    resource: string,
    content: FileSystem.Content & { readonly encoding: "base64" },
  ) => Effect.Effect<
    FileSystem.Content & { readonly encoding: "base64" },
    ResizerUnavailableError | DecodeError | SizeError
  >
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Image") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const state = State.create<DeepMutable<Policy>, Draft>({
      name: "image",
      initial: () => ({
        autoResize: true,
        maxWidth: 2_000,
        maxHeight: 2_000,
        maxBase64Bytes: 5 * 1024 * 1024,
      }),
      draft: (policy) => ({
        update: (update) => update(policy),
      }),
    })
    const loadAdapter = yield* Effect.cached(
      Effect.tryPromise({
        try: () => import("./image/photon.js"),
        catch: () => new ResizerUnavailableError(),
      }).pipe(Effect.flatMap((adapter) => adapter.make)),
    )
    const normalize = Effect.fn("Image.normalize")(function* (
      resource: string,
      content: FileSystem.Content & { readonly encoding: "base64" },
    ) {
      const policy = state.get()
      const normalize = yield* loadAdapter
      return yield* normalize(resource, content, {
        autoResize: policy.autoResize,
        maxWidth: policy.maxWidth,
        maxHeight: policy.maxHeight,
        maxBase64Bytes: policy.maxBase64Bytes,
      })
    })
    return Service.of({ normalize, transform: state.transform, reload: state.reload })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [] })
