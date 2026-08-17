import { InstallationVersion } from "@opencode-ai/core/installation/version"
import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { Schema } from "effect"
import { OAUTH_DUMMY_KEY } from "../auth"

const AZURE_COGNITIVE_SERVICES_SCOPE = "https://cognitiveservices.azure.com/.default"
const AZURE_FOUNDRY_SCOPE = "https://ai.azure.com/.default"
const AZURE_TOKEN_REFRESH_BUFFER = 60_000

const AzureCliToken = Schema.Struct({
  accessToken: Schema.NonEmptyString,
  expires_on: Schema.Number,
})
const decodeAzureCliToken = Schema.decodeUnknownPromise(AzureCliToken)

type AzureCommand = {
  quiet(): AzureCommand
  json(): Promise<unknown>
}

type AzureShell = (strings: TemplateStringsArray, scope: string) => AzureCommand

export async function AzureAuthPlugin(input: PluginInput): Promise<Hooks> {
  return createAzureAuthHooks(input.$)
}

export function createAzureAuthHooks(
  shell: AzureShell,
  request: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> = fetch,
): Hooks {
  const tokens = new Map<string, { token: string; expires: number }>()
  async function token(scope: string) {
    const cached = tokens.get(scope)
    if (cached && cached.expires - Date.now() > AZURE_TOKEN_REFRESH_BUFFER) return cached.token

    const result = await decodeAzureCliToken(
      await shell`az account get-access-token --scope ${scope} --output json`.quiet().json(),
    )
    const token = { token: result.accessToken, expires: result.expires_on * 1000 }
    tokens.set(scope, token)
    return token.token
  }

  const prompts = []
  if (!process.env.AZURE_RESOURCE_NAME) {
    prompts.push({
      type: "text" as const,
      key: "resourceName",
      message: "Enter Azure Resource Name",
      placeholder: "e.g. my-models",
    })
  }

  return {
    auth: {
      provider: "azure",
      async loader(getAuth) {
        if ((await getAuth()).type !== "oauth") return {}

        return {
          apiKey: OAUTH_DUMMY_KEY,
          async fetch(input: RequestInfo | URL, init?: RequestInit) {
            const headers = new Headers(input instanceof Request ? input.headers : undefined)
            new Headers(init?.headers).forEach((value, key) => headers.set(key, value))
            headers.delete("api-key")
            headers.delete("x-api-key")
            headers.set("authorization", `Bearer ${await token(scopeForRequest(input))}`)
            headers.set("User-Agent", `opencode/${InstallationVersion}`)
            return request(input, { ...init, headers })
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
          async authorize(inputs) {
            return {
              url: "",
              instructions: "Sign in with `az login` before continuing.",
              method: "auto",
              callback: async () => {
                const resourceName = inputs?.resourceName ?? process.env.AZURE_RESOURCE_NAME
                if (!resourceName) throw new Error("Azure Resource Name is required")

                await token(AZURE_COGNITIVE_SERVICES_SCOPE)
                return {
                  type: "success",
                  access: OAUTH_DUMMY_KEY,
                  refresh: OAUTH_DUMMY_KEY,
                  expires: Date.now() + 365 * 24 * 60 * 60 * 1000,
                  accountId: resourceName,
                }
              },
            }
          },
        },
      ],
    },
  }
}

function scopeForRequest(input: RequestInfo | URL) {
  const url = new URL(input instanceof Request ? input.url : input)
  if (url.hostname.endsWith(".services.ai.azure.com") && !url.pathname.startsWith("/models")) {
    return AZURE_FOUNDRY_SCOPE
  }
  return AZURE_COGNITIVE_SERVICES_SCOPE
}
