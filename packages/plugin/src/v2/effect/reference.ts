import type { Reference } from "@opencode-ai/schema/reference"
import type { ReferenceApi } from "@opencode-ai/client/effect/api"
import type { Effect } from "effect"
import type { Transform } from "./registration.js"

export interface ReferenceDraft {
  add(name: string, source: Reference.LocalSource | Reference.GitSource): void
  remove(name: string): void
  list(): readonly (readonly [string, Reference.LocalSource | Reference.GitSource])[]
}

export interface ReferenceDomain extends ReferenceApi<unknown> {
  readonly transform: Transform<ReferenceDraft>
  readonly reload: () => Effect.Effect<void>
}
