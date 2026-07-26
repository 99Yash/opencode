import type { Connection } from "@opencode-ai/schema/connection"
import type { Credential } from "@opencode-ai/schema/credential"
import type { Integration } from "@opencode-ai/schema/integration"
import type { IntegrationApi } from "@opencode-ai/client/effect/api"
import type { Effect, Scope } from "effect"
import type { Transform } from "./registration.js"

export type IntegrationOAuthAuthorization = {
  readonly url: string
  readonly instructions: string
  readonly expiresAt?: number
} & (
  | {
      readonly mode: "auto"
      readonly callback: Effect.Effect<Credential.OAuth, unknown>
    }
  | {
      readonly mode: "code"
      readonly callback: (code: string) => Effect.Effect<Credential.OAuth, unknown>
    }
)
export type IntegrationOAuthMethodRegistration = {
  readonly integrationID: string
  readonly method: Integration.OAuthMethod
  readonly authorize: (inputs: Integration.Inputs) => Effect.Effect<IntegrationOAuthAuthorization, unknown, Scope.Scope>
  readonly refresh?: (credential: Credential.OAuth) => Effect.Effect<Credential.OAuth, unknown>
  readonly label?: (credential: Credential.OAuth) => string | undefined
}
export type IntegrationMethodRegistration =
  | IntegrationOAuthMethodRegistration
  | {
      readonly integrationID: string
      readonly method: Integration.CommandMethod
    }
  | {
      readonly integrationID: string
      readonly method: Integration.KeyMethod
    }
  | {
      readonly integrationID: string
      readonly method: Integration.EnvMethod
    }

export interface IntegrationDraft {
  list(): readonly Integration.Ref[]
  get(id: string): Integration.Ref | undefined
  update(id: string, update: (integration: Integration.Ref) => void): void
  remove(id: string): void
  readonly method: {
    list(integrationID: string): readonly Integration.Method[]
    update(input: IntegrationMethodRegistration): void
    remove(integrationID: string, method: Integration.Method): void
  }
}

export interface IntegrationDomain extends Omit<IntegrationApi<unknown>, "wellknown"> {
  readonly transform: Transform<IntegrationDraft>
  readonly reload: () => Effect.Effect<void>
  readonly connection: {
    readonly active: (integrationID: string) => Effect.Effect<Connection.Info | undefined>
    readonly resolve: (connection: Connection.Info) => Effect.Effect<Credential.Value | undefined, unknown>
  }
}
