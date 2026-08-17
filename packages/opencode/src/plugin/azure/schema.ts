import { Option, Predicate, Schema } from "effect"

export const AzureResourceID = Schema.NonEmptyString.check(
  Schema.isPattern(
    /^\/subscriptions\/[^/]+\/resourceGroups\/[^/]+\/providers\/Microsoft\.CognitiveServices\/accounts\/[^/]+\/?$/i,
  ),
)

const AzureResourceName = Schema.NonEmptyString.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]*$/i))
const decodeAzureResourceID = Schema.decodeUnknownOption(AzureResourceID)
const decodeAzureResourceName = Schema.decodeUnknownOption(AzureResourceName)
const decodeURL = Schema.decodeUnknownOption(Schema.URLFromString)

function azureResource(input: unknown) {
  if (!Predicate.isString(input)) return undefined
  const value = input.trim()
  const resourceID = decodeAzureResourceID(value)
  if (Option.isSome(resourceID)) {
    const normalized = resourceID.value.replace(/\/$/, "")
    const resourceName = normalized.split("/").at(-1)
    if (resourceName) return { resourceID: normalized, resourceName }
  }

  const resourceName = decodeAzureResourceName(value)
  if (Option.isSome(resourceName)) return { resourceName: resourceName.value }
  return undefined
}

export function azureConnection(input: unknown) {
  const resource = azureResource(input)
  if (resource) return { ...resource, projectEndpoint: undefined }

  const projectEndpoint = foundryProjectEndpoint(input)
  if (!projectEndpoint) return undefined
  const resourceName = azureResourceName(projectEndpoint)
  if (!resourceName) return undefined
  return { projectEndpoint, resourceID: undefined, resourceName }
}

export function azureResourceName(input: unknown) {
  const resource = azureResource(input)
  if (resource) return resource.resourceName

  const endpoint = decodeURL(input)
  if (Option.isNone(endpoint)) return undefined
  if (endpoint.value.protocol !== "https:") return undefined

  const suffix = [".services.ai.azure.com", ".cognitiveservices.azure.com", ".openai.azure.com"].find((value) =>
    endpoint.value.hostname.endsWith(value),
  )
  if (!suffix) return undefined
  return Option.getOrUndefined(decodeAzureResourceName(endpoint.value.hostname.slice(0, -suffix.length)))
}

export function foundryProjectEndpoint(input: unknown) {
  const endpoint = decodeURL(input)
  if (Option.isNone(endpoint)) return undefined
  if (endpoint.value.protocol !== "https:") return undefined
  if (!endpoint.value.hostname.endsWith(".services.ai.azure.com")) return undefined
  if (!/^\/api\/projects\/[^/]+\/?$/.test(endpoint.value.pathname)) return undefined
  return `${endpoint.value.origin}${endpoint.value.pathname.replace(/\/$/, "")}`
}
