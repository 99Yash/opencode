import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { Hooks } from "@opencode-ai/plugin"
import type { Auth, Provider } from "@opencode-ai/sdk/v2"
import { Predicate } from "effect"
import { OAUTH_DUMMY_KEY } from "../../src/auth"
import { createAzureAuthHooks } from "../../src/plugin/azure"
import { azureConnection } from "../../src/plugin/azure/schema"

const provider: Provider = {
  id: "azure",
  name: "Azure",
  source: "custom",
  env: [],
  options: {},
  models: {},
}

const oauth: Auth = {
  type: "oauth",
  access: OAUTH_DUMMY_KEY,
  refresh: OAUTH_DUMMY_KEY,
  expires: Date.now() + 60 * 60 * 1000,
  accountId: "https://test-resource.services.ai.azure.com/api/projects/test-project",
}
const subscriptionID = "00000000-1111-4222-8333-444444444444"

const projectEndpoint = process.env.AZURE_AI_PROJECT_ENDPOINT
const azureApiKey = process.env.AZURE_API_KEY
const resourceID = process.env.AZURE_RESOURCE_ID
const resourceName = process.env.AZURE_RESOURCE_NAME

beforeEach(() => {
  delete process.env.AZURE_AI_PROJECT_ENDPOINT
  delete process.env.AZURE_API_KEY
  delete process.env.AZURE_RESOURCE_ID
  delete process.env.AZURE_RESOURCE_NAME
})
afterEach(() => {
  if (projectEndpoint === undefined) delete process.env.AZURE_AI_PROJECT_ENDPOINT
  else process.env.AZURE_AI_PROJECT_ENDPOINT = projectEndpoint
  if (azureApiKey === undefined) delete process.env.AZURE_API_KEY
  else process.env.AZURE_API_KEY = azureApiKey
  if (resourceID === undefined) delete process.env.AZURE_RESOURCE_ID
  else process.env.AZURE_RESOURCE_ID = resourceID
  if (resourceName === undefined) delete process.env.AZURE_RESOURCE_NAME
  else process.env.AZURE_RESOURCE_NAME = resourceName
})

function loader(hooks: Hooks) {
  if (!hooks.auth?.loader) throw new Error("Azure auth loader is missing")
  return hooks.auth.loader
}

function modelHook(hooks: Hooks) {
  if (!hooks.provider?.models) throw new Error("Azure provider model hook is missing")
  return hooks.provider.models
}

function oauthMethod(hooks: Hooks) {
  const method = hooks.auth?.methods.find((method) => method.type === "oauth")
  if (!method || method.type !== "oauth") throw new Error("Azure OAuth method is missing")
  return method
}

function customFetch(options: Record<string, unknown>) {
  const result = options["fetch"]
  if (!Predicate.isFunction(result)) throw new Error("Azure custom fetch is missing")
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await result(input, init)
    if (!(response instanceof Response)) throw new Error("Azure custom fetch did not return a response")
    return response
  }
}

function tokenOutput(
  accessToken: string,
  expires = Date.now() + 60 * 60 * 1000,
  subscription: string | null = subscriptionID,
) {
  return JSON.stringify({ accessToken, expires_on: Math.floor(expires / 1000), subscription })
}

function models(...ids: string[]): Provider["models"] {
  return Object.fromEntries(
    ids.map((id) => [
      id,
      {
        id,
        providerID: provider.id,
        api: { id, url: "", npm: "@ai-sdk/openai-compatible" },
        name: id,
        capabilities: {
          temperature: true,
          reasoning: false,
          attachment: false,
          toolcall: true,
          input: { text: true, audio: false, image: false, video: false, pdf: false },
          output: { text: true, audio: false, image: false, video: false, pdf: false },
          interleaved: false,
        },
        cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
        limit: { context: 0, output: 0 },
        status: "active" as const,
        options: {},
        headers: {},
        release_date: "",
      },
    ]),
  )
}

function captureRequests() {
  const requests: Array<{ url: string; headers: Headers }> = []
  return {
    requests,
    request: async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        url: input instanceof Request ? input.url : input.toString(),
        headers: new Headers(init?.headers),
      })
      return new Response(null, { status: 200 })
    },
  }
}

describe("plugin.azure", () => {
  test("exposes one Azure auth surface for API key and Entra ID", () => {
    const hooks = createAzureAuthHooks()

    expect(hooks.auth?.provider).toBe("azure")
    expect(hooks.auth?.methods.map((method) => [method.type, method.label])).toEqual([
      ["api", "API key"],
      ["oauth", "Microsoft Entra ID (Azure CLI)"],
    ])
    expect(hooks.provider?.id).toBe("azure")
    expect(hooks.auth?.methods.map((method) => method.prompts?.[0])).toEqual([
      expect.objectContaining({ type: "select", key: "connectionType", message: "Select Azure connection type" }),
      expect.objectContaining({ type: "text", key: "connection", message: "Enter Azure Resource name" }),
    ])
  })

  test("normalizes every supported Azure connection locator", () => {
    expect(azureConnection("test-resource")).toMatchObject({ resourceName: "test-resource" })
    expect(
      azureConnection(
        "/subscriptions/00000000-1111-2222-3333-444444444444/resourceGroups/test-rg/providers/Microsoft.CognitiveServices/accounts/test-resource/",
      ),
    ).toEqual({
      resourceID:
        "/subscriptions/00000000-1111-2222-3333-444444444444/resourceGroups/test-rg/providers/Microsoft.CognitiveServices/accounts/test-resource",
      resourceName: "test-resource",
      projectEndpoint: undefined,
    })
    expect(azureConnection("https://test-resource.services.ai.azure.com/api/projects/test-project/")).toEqual({
      projectEndpoint: "https://test-resource.services.ai.azure.com/api/projects/test-project",
      resourceID: undefined,
      resourceName: "test-resource",
    })
  })

  test("maps exact Foundry project model metadata to OpenCode model IDs", async () => {
    const scopes: string[] = []
    const requests: string[] = []
    const hooks = createAzureAuthHooks({
      request: async (input) => {
        const url = input instanceof Request ? input.url : input.toString()
        requests.push(url)
        if (url.includes("/api/projects/")) {
          return Response.json({
            value: [
              {
                name: "production-gpt",
                type: "ModelDeployment",
                modelName: "gpt-5-mini",
              },
              {
                name: "production-deepseek",
                type: "ModelDeployment",
                modelName: "DeepSeek-V4-Flash",
              },
              {
                name: "custom-instruct",
                type: "ModelDeployment",
                modelName: "custom-instruct",
              },
            ],
          })
        }
        throw new Error(`Unexpected request: ${url}`)
      },
      tokenCommand: async (scope) => {
        scopes.push(scope)
        return { stdout: tokenOutput(`${scope}-token`), stderr: "", exitCode: 0 }
      },
    })
    const list = modelHook(hooks)

    const result = await list(
      { ...provider, models: models("gpt-5-mini", "deepseek-v4-flash", "custom") },
      { auth: oauth },
    )

    expect(Object.keys(result)).toEqual(["gpt-5-mini", "deepseek-v4-flash"])
    expect(result["gpt-5-mini"].api.id).toBe("production-gpt")
    expect(result["deepseek-v4-flash"].api.id).toBe("production-deepseek")
    expect(scopes).toEqual(["https://ai.azure.com/.default"])
    expect(requests).toHaveLength(1)
  })

  test("lists project deployments with an API key without invoking Azure CLI", async () => {
    let cliCalls = 0
    const requests: Array<{ url: string; headers: Headers }> = []
    const hooks = createAzureAuthHooks({
      request: async (input, init) => {
        requests.push({
          url: input instanceof Request ? input.url : input.toString(),
          headers: new Headers(init?.headers),
        })
        return Response.json({
          value: [{ name: "claude-haiku-4-5", type: "ModelDeployment" }],
        })
      },
      tokenCommand: async () => {
        cliCalls++
        throw new Error("Azure CLI should not be used for API key auth")
      },
    })
    const list = modelHook(hooks)

    const result = await list(
      { ...provider, models: models("gpt-5-mini", "claude-haiku-4-5") },
      {
        auth: {
          type: "api",
          key: "project-key",
          metadata: {
            connectionType: "projectEndpoint",
            projectEndpoint: "https://test-resource.services.ai.azure.com/api/projects/test-project",
          },
        },
      },
    )
    const legacy = await list(
      { ...provider, models: models("gpt-5-mini", "claude-haiku-4-5") },
      {
        auth: {
          type: "api",
          key: "project-key",
          metadata: {
            resourceName: "https://test-resource.services.ai.azure.com/api/projects/test-project",
          },
        },
      },
    )

    expect(Object.keys(result)).toEqual(["claude-haiku-4-5"])
    expect(Object.keys(legacy)).toEqual(["claude-haiku-4-5"])
    expect(cliCalls).toBe(0)
    expect(requests).toHaveLength(2)
    expect(requests.map((request) => request.headers.get("api-key"))).toEqual(["project-key", "project-key"])
    expect(requests.map((request) => request.headers.get("authorization"))).toEqual([null, null])
  })

  test("keeps the app usable when Foundry authentication is unavailable", async () => {
    const hooks = createAzureAuthHooks({
      tokenCommand: async () => ({ stdout: "", stderr: "Run `az login`", exitCode: 1 }),
    })
    const list = modelHook(hooks)

    expect(await list({ ...provider, models: models("gpt-5-mini") }, { auth: oauth })).toEqual({})
  })

  test("keeps the app usable when Azure discovery times out", async () => {
    const hooks = createAzureAuthHooks({
      request: async () => {
        throw new DOMException("The operation timed out", "TimeoutError")
      },
    })
    const list = modelHook(hooks)

    expect(
      await list(
        { ...provider, models: models("gpt-5-mini") },
        {
          auth: {
            type: "api",
            key: "project-key",
            metadata: { connection: oauth.accountId ?? "" },
          },
        },
      ),
    ).toEqual({})
  })

  test("lists succeeded Azure deployments without changing their deployment IDs", async () => {
    const scopes: string[] = []
    const requests: Array<{ url: string; headers: Headers }> = []
    const hooks = createAzureAuthHooks({
      request: async (input, init) => {
        requests.push({
          url: input instanceof Request ? input.url : input.toString(),
          headers: new Headers(init?.headers),
        })
        return Response.json({
          value: [
            { name: "gpt-5-mini", properties: { provisioningState: "Succeeded" } },
            { name: "gpt-5.6-luna", properties: { provisioningState: "Creating" } },
            {
              name: "DeepSeek-V4-Flash",
              properties: {
                provisioningState: "Succeeded",
                model: { name: "DeepSeek-V4-Flash", format: "DeepSeek" },
              },
            },
          ],
        })
      },
      tokenCommand: async (scope) => {
        scopes.push(scope)
        return { stdout: tokenOutput("management-token"), stderr: "", exitCode: 0 }
      },
    })
    const list = modelHook(hooks)

    const result = await list(
      { ...provider, models: models("gpt-5-mini", "gpt-5.6-luna", "gpt-5-nano", "deepseek-v4-flash") },
      {
        auth: {
          ...oauth,
          accountId:
            "/subscriptions/00000000-1111-2222-3333-444444444444/resourceGroups/test-rg/providers/Microsoft.CognitiveServices/accounts/test-resource",
        },
      },
    )

    expect(Object.keys(result)).toEqual(["gpt-5-mini", "deepseek-v4-flash"])
    expect(result["deepseek-v4-flash"].api.id).toBe("DeepSeek-V4-Flash")
    expect(scopes).toEqual(["https://management.azure.com/.default"])
    expect(requests).toHaveLength(1)
    expect(requests[0].url).toBe(
      "https://management.azure.com/subscriptions/00000000-1111-2222-3333-444444444444/resourceGroups/test-rg/providers/Microsoft.CognitiveServices/accounts/test-resource/deployments?api-version=2024-10-01",
    )
    expect(requests[0].headers.get("authorization")).toBe("Bearer management-token")
  })

  test("resolves a Resource Name in the active subscription before listing deployments", async () => {
    const scopes: string[] = []
    const requests: Array<{ url: string; headers: Headers }> = []
    const hooks = createAzureAuthHooks({
      request: async (input, init) => {
        const url = input instanceof Request ? input.url : input.toString()
        requests.push({ url, headers: new Headers(init?.headers) })
        if (url.endsWith("/providers/Microsoft.CognitiveServices/accounts?api-version=2024-10-01")) {
          return Response.json({
            value: [
              {
                id: `/subscriptions/${subscriptionID}/resourceGroups/test-rg/providers/Microsoft.CognitiveServices/accounts/test-resource`,
                name: "test-resource",
              },
            ],
          })
        }
        return Response.json({
          value: [
            { name: "gpt-5-mini", properties: { provisioningState: "Succeeded" } },
            { name: "gpt-5.6-luna", properties: { provisioningState: "Creating" } },
          ],
        })
      },
      tokenCommand: async (scope) => {
        scopes.push(scope)
        return { stdout: tokenOutput("management-token"), stderr: "", exitCode: 0 }
      },
    })
    const list = modelHook(hooks)

    const result = await list(
      { ...provider, models: models("gpt-5-mini", "gpt-5.6-luna") },
      { auth: { ...oauth, accountId: "test-resource" } },
    )

    expect(Object.keys(result)).toEqual(["gpt-5-mini"])
    expect(scopes).toEqual(["https://management.azure.com/.default"])
    expect(requests.map((request) => request.url)).toEqual([
      `https://management.azure.com/subscriptions/${subscriptionID}/providers/Microsoft.CognitiveServices/accounts?api-version=2024-10-01`,
      `https://management.azure.com/subscriptions/${subscriptionID}/resourceGroups/test-rg/providers/Microsoft.CognitiveServices/accounts/test-resource/deployments?api-version=2024-10-01`,
    ])
    expect(requests.map((request) => request.headers.get("authorization"))).toEqual([
      "Bearer management-token",
      "Bearer management-token",
    ])
  })

  test("keeps the app usable when Azure CLI does not return an active subscription", async () => {
    const hooks = createAzureAuthHooks({
      tokenCommand: async () => ({
        stdout: tokenOutput("management-token", Date.now() + 60 * 60 * 1000, null),
        stderr: "",
        exitCode: 0,
      }),
    })
    const list = modelHook(hooks)

    expect(
      await list({ ...provider, models: models("gpt-5-mini") }, { auth: { ...oauth, accountId: "test-resource" } }),
    ).toEqual({})
  })

  test("keeps the app usable when the Resource Name is absent from the active subscription", async () => {
    const hooks = createAzureAuthHooks({
      request: async () => Response.json({ value: [] }),
      tokenCommand: async () => ({ stdout: tokenOutput("management-token"), stderr: "", exitCode: 0 }),
    })
    const list = modelHook(hooks)

    expect(
      await list({ ...provider, models: models("gpt-5-mini") }, { auth: { ...oauth, accountId: "missing-resource" } }),
    ).toEqual({})
  })

  test("keeps the app usable when the Resource ID cannot list deployments", async () => {
    let signal: AbortSignal | null | undefined
    const hooks = createAzureAuthHooks({
      request: async (_input, init) => {
        signal = init?.signal
        return new Response(null, { status: 404 })
      },
      tokenCommand: async () => ({ stdout: tokenOutput("management-token"), stderr: "", exitCode: 0 }),
    })
    const list = modelHook(hooks)

    expect(
      await list(
        { ...provider, models: models("gpt-5-mini") },
        {
          auth: {
            ...oauth,
            accountId:
              "/subscriptions/00000000-1111-2222-3333-444444444444/resourceGroups/test-rg/providers/Microsoft.CognitiveServices/accounts/missing-resource",
          },
        },
      ),
    ).toEqual({})
    expect(signal).toBeInstanceOf(AbortSignal)
  })

  test("selects the token scope from the request route and strips API key headers", async () => {
    const scopes: string[] = []
    const captured = captureRequests()
    const hooks = createAzureAuthHooks({
      request: captured.request,
      tokenCommand: async (scope) => {
        scopes.push(scope)
        return {
          stdout: tokenOutput(scope === "https://ai.azure.com/.default" ? "foundry-token" : "cognitive-token"),
          stderr: "",
          exitCode: 0,
        }
      },
    })
    const fetch = customFetch(await loader(hooks)(async () => oauth, provider))

    await fetch("https://test-resource.services.ai.azure.com/anthropic/v1/messages", {
      headers: { "api-key": "dummy", "x-api-key": "dummy", "x-keep": "yes" },
    })
    await fetch("https://test-resource.services.ai.azure.com/models/chat/completions")
    await fetch("https://test-resource.cognitiveservices.azure.com/openai/v1/responses")

    expect(scopes).toEqual(["https://ai.azure.com/.default", "https://cognitiveservices.azure.com/.default"])
    expect(captured.requests.map((request) => request.headers.get("authorization"))).toEqual([
      "Bearer foundry-token",
      "Bearer cognitive-token",
      "Bearer cognitive-token",
    ])
    expect(captured.requests[0].headers.get("api-key")).toBeNull()
    expect(captured.requests[0].headers.get("x-api-key")).toBeNull()
    expect(captured.requests[0].headers.get("x-keep")).toBe("yes")
    expect(captured.requests[0].headers.get("user-agent")).toMatch(/^opencode\//)
  })

  test("does not send Azure OAuth tokens to unsupported endpoints", async () => {
    const scopes: string[] = []
    const captured = captureRequests()
    const hooks = createAzureAuthHooks({
      request: captured.request,
      tokenCommand: async (scope) => {
        scopes.push(scope)
        return { stdout: tokenOutput("azure-token"), stderr: "", exitCode: 0 }
      },
    })
    const fetch = customFetch(await loader(hooks)(async () => oauth, provider))

    expect(fetch("https://example.com/v1/responses")).rejects.toThrow("Azure OAuth only supports Azure HTTPS endpoints")
    expect(scopes).toEqual([])
    expect(captured.requests).toEqual([])
  })

  test("deduplicates concurrent Azure CLI requests and caches the token", async () => {
    const scopes: string[] = []
    const hooks = createAzureAuthHooks({
      request: captureRequests().request,
      tokenCommand: async (scope) => {
        scopes.push(scope)
        await Bun.sleep(20)
        return { stdout: tokenOutput("shared-token"), stderr: "", exitCode: 0 }
      },
    })
    const fetch = customFetch(await loader(hooks)(async () => oauth, provider))
    const url = "https://test-resource.openai.azure.com/openai/v1/responses"

    await Promise.all([fetch(url), fetch(url), fetch(url)])
    await fetch(url)

    expect(scopes).toEqual(["https://cognitiveservices.azure.com/.default"])
  })

  test("accepts the legacy expiresOn field", async () => {
    const captured = captureRequests()
    let calls = 0
    const hooks = createAzureAuthHooks({
      request: captured.request,
      tokenCommand: async () => {
        calls++
        return {
          stdout: JSON.stringify({
            accessToken: "legacy-token",
            expiresOn: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          }),
          stderr: "",
          exitCode: 0,
        }
      },
    })
    const fetch = customFetch(await loader(hooks)(async () => oauth, provider))

    await fetch("https://test-resource.openai.azure.com/openai/v1/responses")
    await fetch("https://test-resource.openai.azure.com/openai/v1/responses")

    expect(calls).toBe(1)
    expect(captured.requests[0].headers.get("authorization")).toBe("Bearer legacy-token")
  })

  test("does not cache invalid Azure CLI output", async () => {
    const captured = captureRequests()
    let calls = 0
    const hooks = createAzureAuthHooks({
      request: captured.request,
      tokenCommand: async () => {
        calls++
        return {
          stdout: calls === 1 ? "not-json" : tokenOutput("recovered-token"),
          stderr: "",
          exitCode: 0,
        }
      },
    })
    const fetch = customFetch(await loader(hooks)(async () => oauth, provider))
    const url = "https://test-resource.openai.azure.com/openai/v1/responses"

    const error = await fetch(url).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(error).toBeInstanceOf(Error)
    if (!(error instanceof Error)) throw new Error("Expected Azure token loading to fail")
    expect(error.message).toBe("Azure CLI did not return a valid access token")
    await fetch(url)

    expect(calls).toBe(2)
    expect(captured.requests[0].headers.get("authorization")).toBe("Bearer recovered-token")
  })

  test("accepts a Foundry project endpoint and checks Azure CLI before storing it", async () => {
    const scopes: string[] = []
    const hooks = createAzureAuthHooks({
      tokenCommand: async (scope) => {
        scopes.push(scope)
        return { stdout: tokenOutput("connect-token"), stderr: "", exitCode: 0 }
      },
    })
    const method = oauthMethod(hooks)
    const prompt = method.prompts?.find((prompt) => prompt.key === "connection")
    if (!prompt || prompt.type !== "text") throw new Error("Azure Resource name prompt is missing")

    expect(prompt.validate?.("not/a/resource")).toBe(
      "Enter an Azure Resource name, full Resource ID, or Foundry Project endpoint",
    )
    expect(prompt.validate?.("https://connected-resource.services.ai.azure.com/api/projects/connected-project")).toBe(
      undefined,
    )

    const authorization = await method.authorize({
      connection: "https://connected-resource.services.ai.azure.com/api/projects/connected-project/",
    })
    if (authorization.method !== "auto") throw new Error("Unexpected Azure authorization method")
    const result = await authorization.callback()

    expect(authorization.url).toBe("")
    expect(scopes).toEqual(["https://ai.azure.com/.default"])
    expect(result).toMatchObject({
      type: "success",
      access: OAUTH_DUMMY_KEY,
      refresh: OAUTH_DUMMY_KEY,
      accountId: "https://connected-resource.services.ai.azure.com/api/projects/connected-project",
    })
  })

  test("validates and stores a normalized Azure Resource ID", async () => {
    const hooks = createAzureAuthHooks({
      tokenCommand: async () => ({ stdout: tokenOutput("connect-token"), stderr: "", exitCode: 0 }),
    })
    const method = oauthMethod(hooks)
    const prompt = method.prompts?.find((prompt) => prompt.key === "connection")
    if (!prompt || prompt.type !== "text") throw new Error("Azure Resource name prompt is missing")

    expect(prompt.validate?.("not/a/resource")).toBe(
      "Enter an Azure Resource name, full Resource ID, or Foundry Project endpoint",
    )
    const authorization = await method.authorize({
      connection:
        "/subscriptions/00000000-1111-2222-3333-444444444444/resourceGroups/test-rg/providers/Microsoft.CognitiveServices/accounts/test-resource/",
    })
    if (authorization.method !== "auto") throw new Error("Unexpected Azure authorization method")

    expect(await authorization.callback()).toMatchObject({
      type: "success",
      accountId:
        "/subscriptions/00000000-1111-2222-3333-444444444444/resourceGroups/test-rg/providers/Microsoft.CognitiveServices/accounts/test-resource",
    })
  })

  test("uses the first valid Azure account environment value", async () => {
    process.env.AZURE_RESOURCE_ID = "not/a/resource"
    process.env.AZURE_RESOURCE_NAME = "test-resource"
    const hooks = createAzureAuthHooks({
      tokenCommand: async () => ({ stdout: tokenOutput("connect-token"), stderr: "", exitCode: 0 }),
    })
    const method = oauthMethod(hooks)

    expect(method.prompts).toEqual([])
    const authorization = await method.authorize()
    if (authorization.method !== "auto") throw new Error("Unexpected Azure authorization method")
    expect(await authorization.callback()).toMatchObject({
      type: "success",
      accountId: "test-resource",
    })
  })
})
