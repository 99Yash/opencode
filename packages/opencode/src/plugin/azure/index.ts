import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { azureAccount } from "./schema"
import {
  AZURE_COGNITIVE_SERVICES_SCOPE,
  AZURE_DISCOVERY_TIMEOUT,
  createAzureAuth,
  deployedModels,
  listAzureResourceDeployments,
  resolveAzureResourceID,
  type AzureAuthPluginOptions,
} from "./shared"

const AZURE_RESOURCE_ID_ENV = "AZURE_RESOURCE_ID"

export async function AzureAuthPlugin(_input: PluginInput): Promise<Hooks> {
  return createAzureAuthHooks()
}

export function createAzureAuthHooks(options: AzureAuthPluginOptions = {}): Hooks {
  const shared = createAzureAuth(
    {
      provider: "azure",
      envs: [AZURE_RESOURCE_ID_ENV, "AZURE_RESOURCE_NAME"],
      scope: AZURE_COGNITIVE_SERVICES_SCOPE,
      key: "resourceName",
      message: "Enter Azure Resource Name or Resource ID",
      placeholder: "my-models",
      validationMessage: "Enter an Azure Resource Name like my-models or a full Resource ID",
      instructions:
        "Sign in with `az login`. Assign the signed-in identity the Cognitive Services OpenAI User role on this resource; Owner or Contributor alone is not sufficient.",
      normalize(input) {
        const account = azureAccount(input)
        return account?.resourceID ?? account?.resourceName
      },
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

        const signal = AbortSignal.timeout(AZURE_DISCOVERY_TIMEOUT)
        const resourceID =
          account.resourceID ??
          (await resolveAzureResourceID(account.resourceName, shared.credential, shared.request, signal).catch(
            () => undefined,
          ))
        if (!resourceID) return {}

        const deployments = await listAzureResourceDeployments(resourceID, shared.token, shared.request, signal).catch(
          () => [],
        )
        return deployedModels(info.models, deployments)
      },
    },
  }
}
