import { InstallationVersion } from "@opencode-ai/core/installation/version"
import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import type { Auth } from "@opencode-ai/sdk/v2"
import { Option, Predicate, Schema } from "effect"
import { OAUTH_DUMMY_KEY } from "../auth"

const AZURE_COGNITIVE_SERVICES_SCOPE = "https://cognitiveservices.azure.com/.default"
const AZURE_COGNITIVE_SERVICES_API_KEY_ENV = "AZURE_COGNITIVE_SERVICES_API_KEY"
const AZURE_FOUNDRY_SCOPE = "https://ai.azure.com/.default"
const AZURE_FOUNDRY_PROJECT_ENDPOINT_ENV = "AZURE_AI_PROJECT_ENDPOINT"
const AZURE_TOKEN_REFRESH_BUFFER = 60_000

const AzureCliToken = Schema.Struct({
  accessToken: Schema.NonEmptyString,
  expires_on: Schema.optionalKey(Schema.Number),
  expiresOn: Schema.optionalKey(Schema.String),
})
const decodeAzureCliToken = Schema.decodeUnknownOption(Schema.fromJsonString(AzureCliToken))
const decodeURL = Schema.decodeUnknownOption(Schema.URLFromString)

const AzureFoundryDeployments = Schema.Struct({
  value: Schema.Array(
    Schema.Struct({
      name: Schema.NonEmptyString,
      type: Schema.Literal("ModelDeployment"),
    }),
  ),
  nextLink: Schema.optionalKey(Schema.String),
})
const decodeAzureFoundryDeployments = Schema.decodeUnknownOption(Schema.fromJsonString(AzureFoundryDeployments))

const AzureProviders = {
  azure: {
    accountEnv: "AZURE_RESOURCE_NAME",
    accountKey: "resourceName",
    accountMessage: "Enter Azure Resource Name",
    accountPlaceholder: "e.g. my-models",
    oauthInstructions:
      "Sign in with `az login`. Assign the signed-in identity the Cognitive Services OpenAI User role on this resource; Owner or Contributor alone is not sufficient.",
    validate: undefined,
  },
  "azure-cognitive-services": {
    accountEnv: AZURE_FOUNDRY_PROJECT_ENDPOINT_ENV,
    accountKey: "projectEndpoint",
    accountMessage: "Enter Microsoft Foundry Project Endpoint",
    accountPlaceholder: "https://my-resource.services.ai.azure.com/api/projects/my-project",
    oauthInstructions:
      "Sign in with `az login`. Assign the signed-in identity the Foundry User role on this project; Owner or Contributor alone is not sufficient.",
    validate: (value: string) =>
      foundryProjectEndpoint(value)
        ? undefined
        : "Enter a Project endpoint like https://RESOURCE.services.ai.azure.com/api/projects/PROJECT",
  },
} as const

type AzureProvider = keyof typeof AzureProviders
type AzureCliCommandResult = {
  stdout: string
  stderr: string
  exitCode: number
}
type AzureCliTokenCommand = (scope: string) => Promise<AzureCliCommandResult>

type AzureAuthPluginOptions = {
  tokenCommand?: AzureCliTokenCommand
  request?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
}

export async function AzureAuthPlugin(_input: PluginInput): Promise<Hooks> {
  return createAzureAuthHooks("azure")
}

export async function AzureCognitiveServicesAuthPlugin(_input: PluginInput): Promise<Hooks> {
  return createAzureAuthHooks("azure-cognitive-services")
}

export function createAzureAuthHooks(provider: AzureProvider, options: AzureAuthPluginOptions = {}): Hooks {
  const config = AzureProviders[provider]
  const tokenProvider = azureCliTokenProvider(options.tokenCommand ?? runAzureCliTokenCommand)
  const request = options.request ?? fetch
  const configuredAccount = process.env[config.accountEnv]
  const prompts =
    configuredAccount && !config.validate?.(configuredAccount)
      ? []
      : [
          {
            type: "text" as const,
            key: config.accountKey,
            message: config.accountMessage,
            placeholder: config.accountPlaceholder,
            validate: config.validate,
          },
        ]
  const providerHook: Hooks["provider"] =
    provider === "azure-cognitive-services"
      ? {
          id: provider,
          async models(info, context) {
            const apiKey = process.env[AZURE_COGNITIVE_SERVICES_API_KEY_ENV]
            const auth = context.auth ?? (apiKey ? { type: "api" as const, key: apiKey } : undefined)
            const endpoint = [
              process.env[AZURE_FOUNDRY_PROJECT_ENDPOINT_ENV],
              auth?.type === "oauth" ? auth.accountId : undefined,
              auth?.type === "api" ? auth.metadata?.projectEndpoint : undefined,
            ]
              .map(foundryProjectEndpoint)
              .find(Predicate.isString)
            if (!endpoint || !auth) return info.models

            const deployments = await listAzureFoundryProjectDeployments(endpoint, auth, tokenProvider, request).catch(
              () => new Set<string>(),
            )
            return Object.fromEntries(Object.entries(info.models).filter(([modelID]) => deployments.has(modelID)))
          },
        }
      : undefined

  return {
    provider: providerHook,
    auth: {
      provider,
      async loader(getAuth) {
        const auth = await getAuth()
        if (auth.type !== "oauth") return {}

        return {
          apiKey: OAUTH_DUMMY_KEY,
          async fetch(requestInput: RequestInfo | URL, init?: RequestInit) {
            const currentAuth = await getAuth()
            if (currentAuth.type !== "oauth") return request(requestInput, init)

            const headers = new Headers(requestInput instanceof Request ? requestInput.headers : undefined)
            new Headers(init?.headers).forEach((value, key) => headers.set(key, value))
            headers.delete("api-key")
            headers.delete("x-api-key")
            headers.set("authorization", `Bearer ${await tokenProvider(scopeForRequest(requestInput))}`)
            headers.set("User-Agent", `opencode/${InstallationVersion}`)

            return request(requestInput, { ...init, headers })
          },
        }
      },
      methods: [
        {
          type: "api",
          label: "API key",
          prompts,
        },
        {
          type: "oauth",
          label: "Microsoft Entra ID (Azure CLI)",
          prompts,
          authorize: async (inputs) => ({
            // Azure CLI owns the interactive sign-in, so OpenCode has no authorization URL to open.
            url: "",
            instructions: config.oauthInstructions,
            method: "auto" as const,
            callback: async () => {
              const account = inputs?.[config.accountKey] || process.env[config.accountEnv]
              if (!account) throw new Error(config.accountMessage)
              const invalid = config.validate?.(account)
              if (invalid) throw new Error(invalid)

              await tokenProvider(AZURE_COGNITIVE_SERVICES_SCOPE)
              return {
                type: "success" as const,
                access: OAUTH_DUMMY_KEY,
                refresh: OAUTH_DUMMY_KEY,
                expires: Date.now() + 365 * 24 * 60 * 60 * 1000,
                accountId: provider === "azure-cognitive-services" ? foundryProjectEndpoint(account) : account,
              }
            },
          }),
        },
      ],
    },
  }
}

function foundryProjectEndpoint(input: unknown) {
  const decoded = decodeURL(input)
  if (Option.isNone(decoded)) return undefined
  if (decoded.value.protocol !== "https:") return undefined
  if (!decoded.value.hostname.endsWith(".services.ai.azure.com")) return undefined
  if (!/^\/api\/projects\/[^/]+\/?$/.test(decoded.value.pathname)) return undefined
  return `${decoded.value.origin}${decoded.value.pathname.replace(/\/$/, "")}`
}

async function listAzureFoundryProjectDeployments(
  endpoint: string,
  auth: Auth,
  tokenProvider: (scope: string) => Promise<string>,
  request: NonNullable<AzureAuthPluginOptions["request"]>,
) {
  if (auth.type === "api") {
    return listAzureFoundryDeployments(
      `${endpoint}/deployments?api-version=v1&deploymentType=ModelDeployment`,
      new Headers({ "api-key": auth.key }),
      request,
    )
  }
  if (auth.type !== "oauth") return new Set<string>()
  return listAzureFoundryDeployments(
    `${endpoint}/deployments?api-version=v1&deploymentType=ModelDeployment`,
    new Headers({ authorization: `Bearer ${await tokenProvider(AZURE_FOUNDRY_SCOPE)}` }),
    request,
  )
}

async function listAzureFoundryDeployments(
  url: string,
  headers: HeadersInit,
  request: NonNullable<AzureAuthPluginOptions["request"]>,
  deployments = new Set<string>(),
): Promise<Set<string>> {
  const response = await request(url, { headers })
  if (!response.ok) throw new Error(`Failed to list Microsoft Foundry deployments (${response.status})`)

  const decoded = decodeAzureFoundryDeployments(await response.text())
  if (Option.isNone(decoded)) throw new Error("Microsoft Foundry returned an invalid deployments response")
  decoded.value.value.forEach((deployment) => deployments.add(deployment.name))
  if (!decoded.value.nextLink) return deployments
  const next = new URL(decoded.value.nextLink, url)
  if (next.origin !== new URL(url).origin) throw new Error("Microsoft Foundry returned an invalid deployments page")
  return listAzureFoundryDeployments(next.toString(), headers, request, deployments)
}

function scopeForRequest(input: RequestInfo | URL) {
  const url = input instanceof Request ? new URL(input.url) : input instanceof URL ? input : new URL(input)
  if (!url.hostname.endsWith(".services.ai.azure.com")) return AZURE_COGNITIVE_SERVICES_SCOPE

  // The shared host serves legacy Model Inference and Foundry-native routes with different token audiences.
  if (url.pathname === "/models" || url.pathname.startsWith("/models/")) return AZURE_COGNITIVE_SERVICES_SCOPE
  return AZURE_FOUNDRY_SCOPE
}

function azureCliTokenProvider(command: AzureCliTokenCommand) {
  const cached = new Map<string, { token: string; expires: number }>()
  const pending = new Map<string, Promise<string>>()

  return async (scope: string) => {
    const hit = cached.get(scope)
    if (hit && hit.expires - Date.now() > AZURE_TOKEN_REFRESH_BUFFER) return hit.token

    const existing = pending.get(scope)
    if (existing) return existing

    const request = loadAzureCliToken(command, scope)
      .then((token) => {
        cached.set(scope, token)
        return token.token
      })
      .finally(() => pending.delete(scope))
    pending.set(scope, request)
    return request
  }
}

async function loadAzureCliToken(command: AzureCliTokenCommand, scope: string) {
  const result = await command(scope)
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
  return { token: decoded.value.accessToken, expires }
}

async function runAzureCliTokenCommand(scope: string) {
  try {
    const proc = Bun.spawn(["az", "account", "get-access-token", "--scope", scope, "--output", "json"], {
      stdout: "pipe",
      stderr: "pipe",
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
