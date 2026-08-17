import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import type { Auth } from "@opencode-ai/sdk/v2"
import { Predicate } from "effect"
import { foundryProjectEndpoint } from "./schema"
import {
  AZURE_FOUNDRY_SCOPE,
  createAzureAuth,
  deployedModels,
  listAzureDeployments,
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

        const deployments = await listAzureFoundryProjectDeployments(
          endpoint,
          auth,
          shared.token,
          shared.request,
        ).catch(() => new Set<string>())
        return deployedModels(info.models, deployments)
      },
    },
  }
}

async function listAzureFoundryProjectDeployments(
  endpoint: string,
  auth: Auth,
  token: (scope: string) => Promise<string>,
  request: AzureRequest,
) {
  if (auth.type === "api") {
    return listAzureDeployments(
      `${endpoint}/deployments?api-version=v1&deploymentType=ModelDeployment`,
      new Headers({ "api-key": auth.key }),
      request,
      (deployment) => deployment.type === "ModelDeployment",
    )
  }
  if (auth.type !== "oauth") return new Set<string>()
  return listAzureDeployments(
    `${endpoint}/deployments?api-version=v1&deploymentType=ModelDeployment`,
    new Headers({ authorization: `Bearer ${await token(AZURE_FOUNDRY_SCOPE)}` }),
    request,
    (deployment) => deployment.type === "ModelDeployment",
  )
}
