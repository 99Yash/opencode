import { InstallationVersion } from "@opencode-ai/core/installation/version"
import type { Hooks } from "@opencode-ai/plugin"
import type { Provider } from "@opencode-ai/sdk/v2"
import { Option, Predicate, Schema } from "effect"
import { OAUTH_DUMMY_KEY } from "../../auth"

export const AZURE_COGNITIVE_SERVICES_SCOPE = "https://cognitiveservices.azure.com/.default"
export const AZURE_FOUNDRY_SCOPE = "https://ai.azure.com/.default"

const AZURE_TOKEN_REFRESH_BUFFER = 60_000

class AzureCliToken extends Schema.Class<AzureCliToken>("AzureCliToken")({
  accessToken: Schema.NonEmptyString,
  expires_on: Schema.optionalKey(Schema.Number),
  expiresOn: Schema.optionalKey(Schema.String),
  subscription: Schema.optionalKey(Schema.NullOr(Schema.String.check(Schema.isUUID()))),
}) {}
const decodeAzureCliToken = Schema.decodeUnknownOption(Schema.fromJsonString(AzureCliToken))

export class AzureDeployment extends Schema.Class<AzureDeployment>("AzureDeployment")({
  name: Schema.NonEmptyString,
  type: Schema.optionalKey(Schema.String),
  properties: Schema.optionalKey(
    Schema.Struct({
      provisioningState: Schema.optionalKey(Schema.String),
    }),
  ),
}) {}

const AzureDeploymentPage = Schema.Struct({
  value: Schema.Array(AzureDeployment),
  nextLink: Schema.optionalKey(Schema.String),
})
const decodeAzureDeploymentPage = Schema.decodeUnknownOption(Schema.fromJsonString(AzureDeploymentPage))

type AzureCliCommandResult = {
  stdout: string
  stderr: string
  exitCode: number
}

type AzureAccountConfig = {
  provider: "azure" | "azure-cognitive-services"
  envs: ReadonlyArray<string>
  scope: string
  key: string
  message: string
  placeholder: string
  validationMessage: string
  instructions: string
  normalize: (input: unknown) => string | undefined
}

export type AzureRequest = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export type AzureAccessToken = {
  token: string
  subscription?: string
}

export type AzureAuthPluginOptions = {
  tokenCommand?: (scope: string) => Promise<AzureCliCommandResult>
  request?: AzureRequest
}

type AzureAuthState = {
  auth: NonNullable<Hooks["auth"]>
  credential: (scope: string) => Promise<AzureAccessToken>
  token: (scope: string) => Promise<string>
  request: AzureRequest
}

export function createAzureAuth(config: AzureAccountConfig, options: AzureAuthPluginOptions = {}): AzureAuthState {
  const credential = azureCliTokenProvider(options.tokenCommand ?? runAzureCliTokenCommand)
  const token = async (scope: string) => (await credential(scope)).token
  const request = options.request ?? fetch
  const configuredAccount = accountFromEnvironment(config)
  const prompts: NonNullable<Hooks["auth"]>["methods"][number]["prompts"] = configuredAccount
    ? []
    : [
        {
          type: "text",
          key: config.key,
          message: config.message,
          placeholder: config.placeholder,
          validate: (value: string) => (config.normalize(value) ? undefined : config.validationMessage),
        },
      ]

  return {
    credential,
    token,
    request,
    auth: {
      provider: config.provider,
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
          prompts,
        },
        {
          type: "oauth",
          label: "Microsoft Entra ID (Azure CLI)",
          prompts,
          authorize: async (inputs) => ({
            // Azure CLI owns the interactive sign-in, so OpenCode has no authorization URL to open.
            url: "",
            instructions: config.instructions,
            method: "auto",
            callback: async () => {
              const account = inputs?.[config.key]
              const normalized = account ? config.normalize(account) : accountFromEnvironment(config)
              if (!normalized) throw new Error(account ? config.validationMessage : config.message)

              await token(config.scope)
              return {
                type: "success",
                access: OAUTH_DUMMY_KEY,
                refresh: OAUTH_DUMMY_KEY,
                expires: Date.now() + 365 * 24 * 60 * 60 * 1000,
                accountId: normalized,
              }
            },
          }),
        },
      ],
    },
  }
}

export async function listAzureDeployments(
  url: string,
  headers: HeadersInit,
  request: AzureRequest,
  include: (deployment: AzureDeployment) => boolean,
  deployments = new Set<string>(),
): Promise<Set<string>> {
  const response = await request(url, { headers })
  if (!response.ok) throw new Error(`Failed to list Azure deployments (${response.status})`)

  const decoded = decodeAzureDeploymentPage(await response.text())
  if (Option.isNone(decoded)) throw new Error("Azure returned an invalid deployments response")
  decoded.value.value.filter(include).forEach((deployment) => deployments.add(deployment.name))
  if (!decoded.value.nextLink) return deployments

  const next = new URL(decoded.value.nextLink, url)
  if (next.origin !== new URL(url).origin) throw new Error("Azure returned an invalid deployments page")
  return listAzureDeployments(next.toString(), headers, request, include, deployments)
}

export function deployedModels(models: Provider["models"], deployments: Set<string>) {
  return Object.fromEntries(Object.entries(models).filter(([modelID]) => deployments.has(modelID)))
}

function accountFromEnvironment(config: AzureAccountConfig) {
  return config.envs.map((name) => config.normalize(process.env[name])).find(Predicate.isString)
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

  return async (scope: string) => {
    const hit = cached.get(scope)
    if (hit && hit.expires - Date.now() > AZURE_TOKEN_REFRESH_BUFFER) return hit

    const existing = pending.get(scope)
    if (existing) return existing

    const loading = loadAzureCliToken(command, scope)
      .then((credential) => {
        cached.set(scope, credential)
        return credential
      })
      .finally(() => pending.delete(scope))
    pending.set(scope, loading)
    return loading
  }
}

async function loadAzureCliToken(command: NonNullable<AzureAuthPluginOptions["tokenCommand"]>, scope: string) {
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
  return {
    token: decoded.value.accessToken,
    expires,
    ...(decoded.value.subscription ? { subscription: decoded.value.subscription } : {}),
  }
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
