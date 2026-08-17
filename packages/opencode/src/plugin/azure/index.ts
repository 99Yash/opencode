import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { Option, Predicate, Schema } from "effect"
import {
  createAzureAuth,
  deployedModels,
  listAzureDeployments,
  type AzureAuthPluginOptions,
  type AzureRequest,
} from "./shared"

const AZURE_RESOURCE_ID_ENV = "AZURE_RESOURCE_ID"
const AZURE_RESOURCE_MANAGER_SCOPE = "https://management.azure.com/.default"
const AZURE_RESOURCE_ID_PATTERN =
  /^\/subscriptions\/[^/]+\/resourceGroups\/[^/]+\/providers\/Microsoft\.CognitiveServices\/accounts\/[^/]+\/?$/i

const decodeAzureResourceID = Schema.decodeUnknownOption(
  Schema.NonEmptyString.check(Schema.isPattern(AZURE_RESOURCE_ID_PATTERN)),
)
const decodeAzureResourceName = Schema.decodeUnknownOption(
  Schema.NonEmptyString.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]*$/i)),
)

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
      message: "Enter Azure Resource ID or Resource Name",
      placeholder: "/subscriptions/.../resourceGroups/.../providers/Microsoft.CognitiveServices/accounts/my-models",
      validationMessage: "Enter an Azure Resource ID or a Resource Name like my-models",
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
        const resourceID = [process.env[AZURE_RESOURCE_ID_ENV], context.auth.accountId]
          .map(azureAccount)
          .find((account) => Predicate.isString(account?.resourceID))?.resourceID
        if (!resourceID) return info.models

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
