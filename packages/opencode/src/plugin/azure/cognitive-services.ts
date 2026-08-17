import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import type { Auth } from "@opencode-ai/sdk/v2"
import { Predicate } from "effect"
import { azureResourceName, foundryProjectEndpoint } from "./schema"
import {
  AZURE_FOUNDRY_SCOPE,
  AZURE_DISCOVERY_TIMEOUT,
  createAzureAuth,
  deployedModels,
  listAzureDeployments,
  listAzureResourceDeployments,
  resolveAzureResourceID,
  type AzureAccessToken,
  type AzureAuthPluginOptions,
  type AzureRequest,
} from "./shared"

const AZURE_COGNITIVE_SERVICES_API_KEY_ENV = "AZURE_COGNITIVE_SERVICES_API_KEY"
const AZURE_FOUNDRY_PROJECT_ENDPOINT_ENV = "AZURE_AI_PROJECT_ENDPOINT"

export async function AzureCognitiveServicesAuthPlugin(_input: PluginInput): Promise<Hooks> {
  return createAzureCognitiveServicesAuthHooks()
}

export function createAzureCognitiveServicesAuthHooks(options: AzureAuthPluginOptions = {}): Hooks {
  const shared = createAzureAuth(
    {
      provider: "azure-cognitive-services",
      envs: [AZURE_FOUNDRY_PROJECT_ENDPOINT_ENV],
      scope: AZURE_FOUNDRY_SCOPE,
      key: "projectEndpoint",
      message: "Enter Microsoft Foundry Project Endpoint",
      placeholder: "https://my-resource.services.ai.azure.com/api/projects/my-project",
      validationMessage: "Enter a Project endpoint like https://RESOURCE.services.ai.azure.com/api/projects/PROJECT",
      instructions:
        "Sign in with `az login`. Assign the signed-in identity the Foundry User role on this Foundry resource; Owner or Contributor alone is not sufficient.",
      normalize: foundryProjectEndpoint,
    },
    options,
  )

  return {
    auth: shared.auth,
    provider: {
      id: "azure-cognitive-services",
      async models(info, context) {
        const apiKey = process.env[AZURE_COGNITIVE_SERVICES_API_KEY_ENV]
        const auth: Auth | undefined = context.auth ?? (apiKey ? { type: "api", key: apiKey } : undefined)
        const endpoint = [
          process.env[AZURE_FOUNDRY_PROJECT_ENDPOINT_ENV],
          auth?.type === "oauth" ? auth.accountId : undefined,
          auth?.type === "api" ? auth.metadata?.projectEndpoint : undefined,
        ]
          .map(foundryProjectEndpoint)
          .find(Predicate.isString)
        if (!endpoint || !auth) return info.models

        const deployments = await listAzureFoundryDeployments(
          endpoint,
          auth,
          shared.credential,
          shared.token,
          shared.request,
          AbortSignal.timeout(AZURE_DISCOVERY_TIMEOUT),
        ).catch(() => [])
        return deployedModels(info.models, deployments)
      },
    },
  }
}

async function listAzureFoundryDeployments(
  endpoint: string,
  auth: Auth,
  credential: (scope: string, signal?: AbortSignal) => Promise<AzureAccessToken>,
  token: (scope: string, signal?: AbortSignal) => Promise<string>,
  request: AzureRequest,
  signal: AbortSignal,
) {
  const project = listAzureFoundryProjectDeployments(endpoint, auth, token, request, signal).catch(() => [])
  if (auth.type !== "oauth") return project

  const resource = listAzureFoundryResourceDeployments(endpoint, credential, token, request, signal).catch(() => [])
  return [...(await project), ...(await resource)]
}

async function listAzureFoundryProjectDeployments(
  endpoint: string,
  auth: Auth,
  token: (scope: string, signal?: AbortSignal) => Promise<string>,
  request: AzureRequest,
  signal: AbortSignal,
) {
  if (auth.type === "api") {
    return listAzureDeployments(
      `${endpoint}/deployments?api-version=v1&deploymentType=ModelDeployment`,
      new Headers({ "api-key": auth.key }),
      request,
      (deployment) => deployment.type === "ModelDeployment",
      signal,
    )
  }
  if (auth.type !== "oauth") return []
  return listAzureDeployments(
    `${endpoint}/deployments?api-version=v1&deploymentType=ModelDeployment`,
    new Headers({ authorization: `Bearer ${await token(AZURE_FOUNDRY_SCOPE, signal)}` }),
    request,
    (deployment) => deployment.type === "ModelDeployment",
    signal,
  )
}

async function listAzureFoundryResourceDeployments(
  endpoint: string,
  credential: (scope: string, signal?: AbortSignal) => Promise<AzureAccessToken>,
  token: (scope: string, signal?: AbortSignal) => Promise<string>,
  request: AzureRequest,
  signal: AbortSignal,
) {
  const resourceName = azureResourceName(endpoint)
  if (!resourceName) return []
  const resourceID = await resolveAzureResourceID(resourceName, credential, request, signal)
  return listAzureResourceDeployments(resourceID, token, request, signal)
}
