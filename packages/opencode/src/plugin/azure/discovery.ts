import type { Provider } from "@opencode-ai/sdk/v2"
import { Option, Schema } from "effect"
import { AZURE_RESOURCE_MANAGER_SCOPE, type AzureAccessToken, type AzureRequest } from "./auth"
import { AzureResourceID } from "./schema"

class AzureDeployment extends Schema.Class<AzureDeployment>("AzureDeployment")({
  name: Schema.NonEmptyString,
  type: Schema.optionalKey(Schema.String),
  modelName: Schema.optionalKey(Schema.NonEmptyString),
  properties: Schema.optionalKey(
    Schema.Struct({
      provisioningState: Schema.optionalKey(Schema.String),
      model: Schema.optionalKey(
        Schema.Struct({
          name: Schema.NonEmptyString,
          format: Schema.optionalKey(Schema.String),
        }),
      ),
    }),
  ),
}) {}

const AzureDeploymentPage = Schema.Struct({
  value: Schema.Array(AzureDeployment),
  nextLink: Schema.optionalKey(Schema.String),
})
const decodeAzureDeploymentPage = Schema.decodeUnknownOption(Schema.fromJsonString(AzureDeploymentPage))

class AzureResource extends Schema.Class<AzureResource>("AzureResource")({
  id: AzureResourceID,
  name: Schema.NonEmptyString,
}) {}

const AzureResourcePage = Schema.Struct({
  value: Schema.Array(AzureResource),
  nextLink: Schema.optionalKey(Schema.String),
})
const decodeAzureResourcePage = Schema.decodeUnknownOption(Schema.fromJsonString(AzureResourcePage))

export function deployedModels(models: Provider["models"], deployments: ReadonlyArray<AzureDeployment>) {
  const found = new Map<string, Provider["models"][string]>()
  deployments.forEach((deployment) => {
    const modelID = deployedModelID(models, deployment)
    if (!modelID) return
    const model = models[modelID]
    if (!model) return
    found.set(modelID, {
      ...model,
      api: {
        ...model.api,
        id: deployment.name,
      },
    })
  })
  return Object.fromEntries(found)
}

export async function resolveAzureResourceID(
  resourceName: string,
  credential: (scope: string, signal?: AbortSignal) => Promise<AzureAccessToken>,
  request: AzureRequest,
  signal: AbortSignal,
) {
  const access = await credential(AZURE_RESOURCE_MANAGER_SCOPE, signal)
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
    signal,
  )
}

export async function listAzureDeployments(
  url: string,
  headers: HeadersInit,
  request: AzureRequest,
  include: (deployment: AzureDeployment) => boolean,
  signal: AbortSignal,
  deployments: ReadonlyArray<AzureDeployment> = [],
): Promise<ReadonlyArray<AzureDeployment>> {
  const response = await request(url, { headers, signal })
  if (!response.ok) throw new Error(`Failed to list Azure deployments (${response.status})`)

  const decoded = decodeAzureDeploymentPage(await response.text())
  if (Option.isNone(decoded)) throw new Error("Azure returned an invalid deployments response")
  const found = [...deployments, ...decoded.value.value.filter(include)]
  if (!decoded.value.nextLink) return found

  const next = new URL(decoded.value.nextLink, url)
  if (next.origin !== new URL(url).origin) throw new Error("Azure returned an invalid deployments page")
  return listAzureDeployments(next.toString(), headers, request, include, signal, found)
}

async function findAzureResourceID(
  url: string,
  resourceName: string,
  token: string,
  request: AzureRequest,
  signal: AbortSignal,
) {
  const response = await request(url, { headers: { authorization: `Bearer ${token}` }, signal })
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
    return findAzureResourceID(next.toString(), resourceName, token, request, signal)
  }

  throw new Error(
    `Azure resource "${resourceName}" was not found in the active subscription. Run \`az account set --subscription NAME_OR_ID\` or reconnect using the full Resource ID.`,
  )
}

function deployedModelID(models: Provider["models"], deployment: AzureDeployment) {
  if (models[deployment.name]) return deployment.name
  const modelName = deployment.modelName ?? deployment.properties?.model?.name
  if (!modelName) return undefined
  return Object.keys(models).find((modelID) => modelID.toLowerCase() === modelName.toLowerCase())
}
