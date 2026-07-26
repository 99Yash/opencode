import type { IntegrationApi } from "@opencode-ai/client/promise/api"
import type { IntegrationDraft, IntegrationMethodRegistration } from "../effect/integration.js"
import type { Connection } from "@opencode-ai/schema/connection"
import type { Credential } from "@opencode-ai/schema/credential"
import type { Transform } from "./registration.js"

export type { IntegrationDraft, IntegrationMethodRegistration }

export type IntegrationOAuthAuthorization = {
  readonly url: string
  readonly instructions: string
  readonly expiresAt?: number
} & (
  | {
      readonly mode: "auto"
      readonly callback: Promise<Credential.OAuth>
    }
  | {
      readonly mode: "code"
      readonly callback: (code: string) => Promise<Credential.OAuth>
    }
)

export interface IntegrationDomain extends Omit<IntegrationApi, "wellknown"> {
  readonly transform: Transform<IntegrationDraft>
  readonly reload: () => Promise<void>
  readonly connection: {
    readonly active: (integrationID: string) => Promise<Connection.Info | undefined>
    readonly resolve: (connection: Connection.Info) => Promise<Credential.Value | undefined>
  }
}
