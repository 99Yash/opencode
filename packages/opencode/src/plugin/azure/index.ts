import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { Option, Schema } from "effect"
import {
  createAzureAuth,
  deployedModels,
  listAzureDeployments,
  type AzureAccessToken,
  type AzureAuthPluginOptions,
  type AzureRequest,
} from "./shared"

const AZURE_RESOURCE_ID_ENV = "AZURE_RESOURCE_ID"
const AZURE_RESOURCE_MANAGER_SCOPE = "https://management.azure.com/.default"
const AZURE_RESOURCE_ID_PATTERN =
  /^\/subscriptions\/[^/]+\/resourceGroups\/[^/]+\/providers\/Microsoft\.CognitiveServices\/accounts\/[^/]+\/?$/i

const AzureResourceID = Schema.NonEmptyString.check(Schema.isPattern(AZURE_RESOURCE_ID_PATTERN))
const decodeAzureResourceID = Schema.decodeUnknownOption(AzureResourceID)
const decodeAzureResourceName = Schema.decodeUnknownOption(
  Schema.NonEmptyString.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]*$/i)),
)

class AzureResource extends Schema.Class<AzureResource>("AzureResource")({
  id: AzureResourceID,
  name: Schema.NonEmptyString,
}) {}

const AzureResourcePage = Schema.Struct({
  value: Schema.Array(AzureResource),
  nextLink: Schema.optionalKey(Schema.String),
})
const decodeAzureResourcePage = Schema.decodeUnknownOption(Schema.fromJsonString(AzureResourcePage))

type AzureAccount = {
  resourceName: string
  resourceID?: string
}

export async function AzureAuthPlugin(_input: PluginInput): Promise<Hooks> {
  return createAzureAuthHooks()
}

export function createAzureAuthHooks(options: AzureAuthPluginOptions = {}): Hooks {
  const shared = createAzureAuth(
    {
      provider: "azure",
      envs: [AZURE_RESOURCE_ID_ENV, "AZURE_RESOURCE_NAME"],
      key: "resourceName",
      message: "Enter Azure Resource Name or Resource ID",
      placeholder: "my-models",
      validationMessage: "Enter an Azure Resource Name like my-models or a full Resource ID",
      instructions:
        "Sign in with `az login`. Assign the signed-in identity the Cognitive Services OpenAI User role on this resource; Owner or Contributor alone is not sufficient.",
      normalize: azureAccountID,
    },
    options,
  )

  return {
    auth: shared.auth,
    provider: {
      id: "azure",
      async models(info, context) {
        if (context.auth?.type !== "oauth") return info.models
        const account =
          azureAccount(process.env[AZURE_RESOURCE_ID_ENV]) ??
          azureAccount(context.auth.accountId) ??
          azureAccount(process.env.AZURE_RESOURCE_NAME)
        if (!account) return info.models

        const resourceID =
          account.resourceID ?? (await resolveAzureResourceID(account.resourceName, shared.credential, shared.request))

        const deployments = await listAzureResourceDeployments(resourceID, shared.token, shared.request).catch(
          () => new Set<string>(),
        )
        return deployedModels(info.models, deployments)
      },
    },
  }
}

function azureAccountID(input: unknown) {
  const account = azureAccount(input)
  return account?.resourceID ?? account?.resourceName
}

function azureAccount(input: unknown): AzureAccount | undefined {
  const resourceID = decodeAzureResourceID(input)
  if (Option.isSome(resourceID)) {
    const value = resourceID.value.replace(/\/$/, "")
    const resourceName = value.split("/").at(-1)
    if (resourceName) return { resourceID: value, resourceName }
  }

  const resourceName = decodeAzureResourceName(input)
  if (Option.isSome(resourceName)) return { resourceName: resourceName.value }
  return undefined
}

async function resolveAzureResourceID(
  resourceName: string,
  credential: (scope: string) => Promise<AzureAccessToken>,
  request: AzureRequest,
) {
  const access = await credential(AZURE_RESOURCE_MANAGER_SCOPE)
  if (!access.subscription) {
    throw new Error(
      "Azure CLI did not return an active subscription. Run `az account set --subscription NAME_OR_ID` and try again.",
    )
  }

  return findAzureResourceID(
    `https://management.azure.com/subscriptions/${access.subscription}/providers/Microsoft.CognitiveServices/accounts?api-version=2024-10-01`,
    resourceName,
    access.token,
    request,
  )
}

async function findAzureResourceID(url: string, resourceName: string, token: string, request: AzureRequest) {
  const response = await request(url, { headers: { authorization: `Bearer ${token}` } })
  if (!response.ok) {
    throw new Error(`Failed to list Azure resources in the active subscription (${response.status})`)
  }

  const decoded = decodeAzureResourcePage(await response.text())
  if (Option.isNone(decoded)) throw new Error("Azure returned an invalid resources response")
  const resource = decoded.value.value.find((item) => item.name.toLowerCase() === resourceName.toLowerCase())
  if (resource) return resource.id.replace(/\/$/, "")
  if (decoded.value.nextLink) {
    const next = new URL(decoded.value.nextLink, url)
    if (next.origin !== new URL(url).origin) throw new Error("Azure returned an invalid resources page")
    return findAzureResourceID(next.toString(), resourceName, token, request)
  }

  throw new Error(
    `Azure resource "${resourceName}" was not found in the active subscription. Run \`az account set --subscription NAME_OR_ID\` or reconnect using the full Resource ID.`,
  )
}

async function listAzureResourceDeployments(
  resourceID: string,
  token: (scope: string) => Promise<string>,
  request: AzureRequest,
) {
  return listAzureDeployments(
    `https://management.azure.com${resourceID}/deployments?api-version=2024-10-01`,
    new Headers({ authorization: `Bearer ${await token(AZURE_RESOURCE_MANAGER_SCOPE)}` }),
    request,
    (deployment) => deployment.properties?.provisioningState === "Succeeded",
  )
}
