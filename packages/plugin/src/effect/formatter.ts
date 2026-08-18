import type { Effect } from "effect"
import type { Transform } from "./registration.js"

export interface FormatterDefinition {
  readonly name: string
  readonly command: readonly string[]
  readonly extensions: readonly string[]
  readonly environment?: Readonly<Record<string, string>>
}

export interface FormatterDraft {
  readonly add: (formatter: FormatterDefinition) => void
  readonly remove: (name: string) => void
}

export interface FormatterDomain {
  readonly transform: Transform<FormatterDraft>
  readonly reload: () => Effect.Effect<void>
}
