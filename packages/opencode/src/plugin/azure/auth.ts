import { InstallationVersion } from "@opencode-ai/core/installation/version"
import type { Hooks } from "@opencode-ai/plugin"
import { Option, Predicate, Schema } from "effect"
import { OAUTH_DUMMY_KEY } from "../../auth"
import { azureConnection, foundryProjectEndpoint } from "./schema"

export const AZURE_COGNITIVE_SERVICES_SCOPE = "https://cognitiveservices.azure.com/.default"
export const AZURE_FOUNDRY_SCOPE = "https://ai.azure.com/.default"
export const AZURE_RESOURCE_MANAGER_SCOPE = "https://management.azure.com/.default"
export const AZURE_FOUNDRY_PROJECT_ENDPOINT_ENV = "AZURE_AI_PROJECT_ENDPOINT"
export const AZURE_RESOURCE_ID_ENV = "AZURE_RESOURCE_ID"
export const AZURE_RESOURCE_NAME_ENV = "AZURE_RESOURCE_NAME"

const AZURE_TOKEN_REFRESH_BUFFER = 60_000

class AzureCliToken extends Schema.Class<AzureCliToken>("AzureCliToken")({
  accessToken: Schema.NonEmptyString,
  expires_on: Schema.optionalKey(Schema.Number),
  expiresOn: Schema.optionalKey(Schema.String),
  subscription: Schema.optionalKey(Schema.NullOr(Schema.String.check(Schema.isUUID()))),
}) {}
const decodeAzureCliToken = Schema.decodeUnknownOption(Schema.fromJsonString(AzureCliToken))

type AzureCliCommandResult = {
  stdout: string
  stderr: string
  exitCode: number
}

type AzureCliCommand = (scope: string, signal?: AbortSignal) => Promise<AzureCliCommandResult>

export type AzureRequest = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export type AzureAccessToken = {
  token: string
  subscription?: string
}

export type AzureAuthPluginOptions = {
  tokenCommand?: AzureCliCommand
  request?: AzureRequest
}

export function createAzureAuth(options: AzureAuthPluginOptions = {}) {
  const credential = azureCliTokenProvider(options.tokenCommand ?? runAzureCliTokenCommand)
  const token = async (scope: string, signal?: AbortSignal) => (await credential(scope, signal)).token
  const request = options.request ?? fetch
  const configured = connectionFromEnvironment() !== undefined

  return {
    credential,
    token,
    request,
    auth: {
      provider: "azure",
      async loader(getAuth) {
        const auth = await getAuth()
        if (auth.type !== "oauth") return {}

        return {
          apiKey: OAUTH_DUMMY_KEY,
          async fetch(requestInput: RequestInfo | URL, init?: RequestInit) {
            const currentAuth = await getAuth()
            if (currentAuth.type !== "oauth") return request(requestInput, init)

            const scope = scopeForRequest(requestInput)
            if (!scope) throw new Error("Azure OAuth only supports Azure HTTPS endpoints")

            const headers = new Headers(requestInput instanceof Request ? requestInput.headers : undefined)
            new Headers(init?.headers).forEach((value, key) => headers.set(key, value))
            headers.delete("api-key")
            headers.delete("x-api-key")
            headers.set("authorization", `Bearer ${await token(scope)}`)
            headers.set("User-Agent", `opencode/${InstallationVersion}`)
            return request(requestInput, { ...init, headers })
          },
        }
      },
      methods: [
        {
          type: "api",
          label: "API key",
          prompts: configured ? [] : apiPrompts(),
        },
        {
          type: "oauth",
          label: "Microsoft Entra ID (Azure CLI)",
          prompts: configured ? [] : oauthPrompts(),
          authorize: async (inputs) => ({
            // Azure CLI owns the interactive sign-in, so OpenCode has no authorization URL to open.
            url: "",
            instructions:
              "Sign in with `az login`. Assign Cognitive Services OpenAI User for Azure OpenAI resources or Foundry User for Foundry resources.",
            method: "auto",
            callback: async () => {
              const input = inputs?.connection ?? inputs?.projectEndpoint ?? inputs?.resourceID ?? inputs?.resourceName
              const connection = input ? azureConnection(input) : connectionFromEnvironment()
              if (!connection) {
                throw new Error("Enter an Azure Resource Name, full Resource ID, or Foundry Project endpoint")
              }

              await token(connection.projectEndpoint ? AZURE_FOUNDRY_SCOPE : AZURE_RESOURCE_MANAGER_SCOPE)
              return {
                type: "success",
                access: OAUTH_DUMMY_KEY,
                refresh: OAUTH_DUMMY_KEY,
                expires: Date.now() + 365 * 24 * 60 * 60 * 1000,
                // OAuth exposes accountId as the durable discriminator for connection-specific credentials.
                accountId: connection.projectEndpoint ?? connection.resourceID ?? connection.resourceName,
              }
            },
          }),
        },
      ],
    } satisfies NonNullable<Hooks["auth"]>,
  }
}

function apiPrompts(): NonNullable<Hooks["auth"]>["methods"][number]["prompts"] {
  return [
    {
      type: "select",
      key: "connectionType",
      message: "Select Azure connection type",
      options: [
        {
          label: "Foundry Project endpoint",
          value: "projectEndpoint",
          hint: "For a Microsoft Foundry project",
        },
        {
          label: "Azure Resource name",
          value: "resourceName",
          hint: "For a standalone Azure OpenAI resource",
        },
        {
          label: "Azure Resource ID",
          value: "resourceID",
          hint: "Full ARM resource ID",
        },
      ],
    },
    {
      type: "text",
      key: "projectEndpoint",
      message: "Enter Foundry Project endpoint",
      placeholder: "https://RESOURCE.services.ai.azure.com/api/projects/PROJECT",
      when: { key: "connectionType", op: "eq", value: "projectEndpoint" },
      validate: (value: string) =>
        foundryProjectEndpoint(value)
          ? undefined
          : "Enter a Project endpoint like https://RESOURCE.services.ai.azure.com/api/projects/PROJECT",
    },
    {
      type: "text",
      key: "resourceName",
      message: "Enter Azure Resource name",
      placeholder: "my-resource",
      when: { key: "connectionType", op: "eq", value: "resourceName" },
      validate: (value: string) => {
        const connection = azureConnection(value)
        return connection && !connection.resourceID && !connection.projectEndpoint
          ? undefined
          : "Enter a Resource name like my-resource"
      },
    },
    {
      type: "text",
      key: "resourceID",
      message: "Enter Azure Resource ID",
      placeholder: "/subscriptions/.../providers/Microsoft.CognitiveServices/accounts/RESOURCE",
      when: { key: "connectionType", op: "eq", value: "resourceID" },
      validate: (value: string) => (azureConnection(value)?.resourceID ? undefined : "Enter the full ARM Resource ID"),
    },
  ]
}

function oauthPrompts(): NonNullable<Hooks["auth"]>["methods"][number]["prompts"] {
  return [
    {
      type: "text",
      key: "connection",
      message: "Enter Azure Resource name",
      placeholder: "my-resource",
      validate: (value: string) =>
        azureConnection(value)
          ? undefined
          : "Enter an Azure Resource name, full Resource ID, or Foundry Project endpoint",
    },
  ]
}

function connectionFromEnvironment() {
  return [AZURE_RESOURCE_ID_ENV, AZURE_FOUNDRY_PROJECT_ENDPOINT_ENV, AZURE_RESOURCE_NAME_ENV]
    .map((name) => azureConnection(process.env[name]))
    .find(Predicate.isNotUndefined)
}

function scopeForRequest(input: RequestInfo | URL) {
  const url = input instanceof Request ? new URL(input.url) : input instanceof URL ? input : new URL(input)
  if (url.protocol !== "https:") return undefined
  if (url.hostname.endsWith(".services.ai.azure.com")) {
    if (url.pathname === "/models" || url.pathname.startsWith("/models/")) {
      return AZURE_COGNITIVE_SERVICES_SCOPE
    }
    return AZURE_FOUNDRY_SCOPE
  }
  if (url.hostname.endsWith(".cognitiveservices.azure.com")) return AZURE_COGNITIVE_SERVICES_SCOPE
  if (url.hostname.endsWith(".openai.azure.com")) return AZURE_COGNITIVE_SERVICES_SCOPE
  return undefined
}

function azureCliTokenProvider(command: NonNullable<AzureAuthPluginOptions["tokenCommand"]>) {
  type CachedToken = AzureAccessToken & { expires: number }

  const cached = new Map<string, CachedToken>()
  const pending = new Map<string, Promise<CachedToken>>()

  return async (scope: string, signal?: AbortSignal) => {
    const hit = cached.get(scope)
    if (hit && hit.expires - Date.now() > AZURE_TOKEN_REFRESH_BUFFER) return hit

    const existing = pending.get(scope)
    if (existing) return existing

    const loading = loadAzureCliToken(command, scope, signal)
      .then((credential) => {
        cached.set(scope, credential)
        return credential
      })
      .finally(() => pending.delete(scope))
    pending.set(scope, loading)
    return loading
  }
}

async function loadAzureCliToken(
  command: NonNullable<AzureAuthPluginOptions["tokenCommand"]>,
  scope: string,
  signal?: AbortSignal,
) {
  const result = await command(scope, signal)
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || "Failed to get Azure access token. Run `az login` and try again.")
  }

  const decoded = decodeAzureCliToken(result.stdout)
  if (Option.isNone(decoded)) throw new Error("Azure CLI did not return a valid access token")

  const expires =
    decoded.value.expires_on !== undefined
      ? decoded.value.expires_on * 1000
      : decoded.value.expiresOn
        ? new Date(decoded.value.expiresOn).getTime()
        : Number.NaN
  if (!Number.isFinite(expires)) throw new Error("Azure CLI did not return a valid token expiry")
  return {
    token: decoded.value.accessToken,
    expires,
    ...(decoded.value.subscription ? { subscription: decoded.value.subscription } : {}),
  }
}

async function runAzureCliTokenCommand(scope: string, signal?: AbortSignal) {
  try {
    const proc = Bun.spawn(["az", "account", "get-access-token", "--scope", scope, "--output", "json"], {
      stdout: "pipe",
      stderr: "pipe",
      signal,
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    return { stdout, stderr, exitCode }
  } catch (error) {
    throw new Error("Azure CLI could not be run. Install `az`, run `az login`, and try again.", {
      cause: error,
    })
  }
}
