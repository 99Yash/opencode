import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import type { Auth } from "@opencode-ai/sdk/v2"
import { Predicate } from "effect"
import {
  AZURE_FOUNDRY_SCOPE,
  AZURE_FOUNDRY_PROJECT_ENDPOINT_ENV,
  AZURE_RESOURCE_MANAGER_SCOPE,
  AZURE_RESOURCE_ID_ENV,
  AZURE_RESOURCE_NAME_ENV,
  createAzureAuth,
  type AzureAuthPluginOptions,
} from "./auth"
import { deployedModels, listAzureDeployments, resolveAzureResourceID } from "./discovery"
import { azureConnection } from "./schema"

const AZURE_DISCOVERY_TIMEOUT = 5_000

export async function AzureAuthPlugin(_input: PluginInput): Promise<Hooks> {
  return createAzureAuthHooks()
}

export function createAzureAuthHooks(options: AzureAuthPluginOptions = {}): Hooks {
  const azure = createAzureAuth(options)

  return {
    auth: azure.auth,
    provider: {
      id: "azure",
      async models(info, context) {
        const apiKey = process.env.AZURE_API_KEY
        const auth: Auth | undefined = context.auth ?? (apiKey ? { type: "api", key: apiKey } : undefined)
        const connection = [
          auth?.type === "oauth" ? auth.accountId : undefined,
          auth?.type === "api" ? auth.metadata?.connection : undefined,
          auth?.type === "api" ? auth.metadata?.resourceID : undefined,
          auth?.type === "api" ? auth.metadata?.projectEndpoint : undefined,
          auth?.type === "api" ? auth.metadata?.resourceName : undefined,
          process.env[AZURE_RESOURCE_ID_ENV],
          process.env[AZURE_FOUNDRY_PROJECT_ENDPOINT_ENV],
          process.env[AZURE_RESOURCE_NAME_ENV],
        ]
          .map(azureConnection)
          .find(Predicate.isNotUndefined)
        if (!connection || !auth) return info.models

        const signal = AbortSignal.timeout(AZURE_DISCOVERY_TIMEOUT)
        if (connection.projectEndpoint) {
          const headers = new Headers()
          if (auth.type === "api") headers.set("api-key", auth.key)
          if (auth.type === "oauth") {
            const token = await azure.token(AZURE_FOUNDRY_SCOPE, signal).catch(() => undefined)
            if (!token) return {}
            headers.set("authorization", `Bearer ${token}`)
          }
          if (auth.type !== "api" && auth.type !== "oauth") return info.models
          const deployments = await listAzureDeployments(
            `${connection.projectEndpoint}/deployments?api-version=v1&deploymentType=ModelDeployment`,
            headers,
            azure.request,
            (deployment) => deployment.type === "ModelDeployment",
            signal,
          ).catch(() => [])
          return deployedModels(info.models, deployments)
        }
        if (auth.type !== "oauth") return info.models

        const resourceID =
          connection.resourceID ??
          (await resolveAzureResourceID(connection.resourceName, azure.credential, azure.request, signal).catch(
            () => undefined,
          ))
        if (!resourceID) return {}

        const token = await azure.token(AZURE_RESOURCE_MANAGER_SCOPE, signal).catch(() => undefined)
        if (!token) return {}
        const deployments = await listAzureDeployments(
          `https://management.azure.com${resourceID}/deployments?api-version=2024-10-01`,
          new Headers({ authorization: `Bearer ${token}` }),
          azure.request,
          (deployment) => deployment.properties?.provisioningState === "Succeeded",
          signal,
        ).catch(() => [])
        return deployedModels(info.models, deployments)
      },
    },
  }
}
