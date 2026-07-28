import { test, expect, describe } from "bun:test"
import {
  McpOAuthPendingProvider,
  McpOAuthProvider,
  OAUTH_CALLBACK_PORT,
  OAUTH_CALLBACK_PATH,
} from "../../src/mcp/oauth-provider"
import type { McpAuth } from "../../src/mcp/auth"
import type { OAuthDiscoveryState } from "@modelcontextprotocol/client"
import { Effect } from "effect"

// Stub auth — only synchronous getters are exercised in these tests
const stubAuth = {} as McpAuth.Interface

const makeProvider = (config: ConstructorParameters<typeof McpOAuthProvider>[2]) =>
  new McpOAuthProvider("test-server", "https://mcp.example.com/mcp", config, { onRedirect: async () => {} }, stubAuth)

describe("McpOAuthProvider.redirectUrl", () => {
  test("defaults to 127.0.0.1:19876/mcp/oauth/callback", () => {
    const provider = makeProvider({})
    expect(provider.redirectUrl).toBe(`http://127.0.0.1:${OAUTH_CALLBACK_PORT}${OAUTH_CALLBACK_PATH}`)
  })

  test("uses callbackPort when set", () => {
    const provider = makeProvider({ callbackPort: 6620 })
    expect(provider.redirectUrl).toBe(`http://127.0.0.1:6620${OAUTH_CALLBACK_PATH}`)
  })

  test("redirectUri takes precedence over callbackPort", () => {
    const provider = makeProvider({
      callbackPort: 6620,
      redirectUri: "http://127.0.0.1:9999/custom/callback",
    })
    expect(provider.redirectUrl).toBe("http://127.0.0.1:9999/custom/callback")
  })

  test("uses explicit redirectUri when set without callbackPort", () => {
    const provider = makeProvider({ redirectUri: "http://127.0.0.1:8080/oauth/callback" })
    expect(provider.redirectUrl).toBe("http://127.0.0.1:8080/oauth/callback")
  })
})

describe("McpOAuthProvider.clientMetadata", () => {
  test("includes redirect_uris from redirectUrl", () => {
    const provider = makeProvider({ callbackPort: 6620 })
    expect(provider.clientMetadata.redirect_uris).toEqual([`http://127.0.0.1:6620${OAUTH_CALLBACK_PATH}`])
  })

  test("includes scope when set in config", () => {
    const provider = makeProvider({ scope: "openid offline_access" })
    expect(provider.clientMetadata.scope).toBe("openid offline_access")
  })

  test("omits scope when not set in config", () => {
    const provider = makeProvider({})
    expect(provider.clientMetadata.scope).toBeUndefined()
  })

  test("sets token_endpoint_auth_method to client_secret_post when clientSecret provided", () => {
    const provider = makeProvider({ clientSecret: "secret" })
    expect(provider.clientMetadata.token_endpoint_auth_method).toBe("client_secret_post")
  })

  test("sets token_endpoint_auth_method to none when no clientSecret", () => {
    const provider = makeProvider({})
    expect(provider.clientMetadata.token_endpoint_auth_method).toBe("none")
  })
})

describe("McpOAuthProvider.discoveryState", () => {
  const discoveryState: OAuthDiscoveryState = {
    authorizationServerUrl: "https://auth.example.com",
    authorizationServerMetadata: {
      issuer: "https://auth.example.com",
      authorization_endpoint: "https://auth.example.com/authorize",
      token_endpoint: "https://auth.example.com/token",
      response_types_supported: ["code"],
    },
    resourceMetadataUrl: "https://mcp.example.com/.well-known/oauth-protected-resource",
  }

  test("persists discovery state through the auth store", async () => {
    let saved: OAuthDiscoveryState | undefined
    const auth = {
      ...stubAuth,
      get: () => Effect.succeed(saved ? { discoveryState: saved } : undefined),
      updateDiscoveryState: (_name: string, value: OAuthDiscoveryState) => Effect.sync(() => void (saved = value)),
      clearDiscoveryState: () => Effect.sync(() => void (saved = undefined)),
    } satisfies McpAuth.Interface
    const provider = new McpOAuthProvider(
      "test-server",
      "https://mcp.example.com/mcp",
      {},
      { onRedirect: async () => {} },
      auth,
    )

    await provider.saveDiscoveryState(discoveryState)

    expect(await provider.discoveryState()).toEqual(discoveryState)
    await provider.invalidateCredentials("discovery")
    expect(await provider.discoveryState()).toBeUndefined()
  })

  test("commits pending discovery state with OAuth credentials", async () => {
    let entry: McpAuth.Entry | undefined
    const auth = {
      ...stubAuth,
      set: (_name: string, value: McpAuth.Entry) => Effect.sync(() => void (entry = value)),
    } satisfies McpAuth.Interface
    const provider = new McpOAuthPendingProvider(
      "test-server",
      "https://mcp.example.com/mcp",
      {},
      { onRedirect: async () => {} },
      auth,
    )

    await provider.saveDiscoveryState(discoveryState)
    await provider.saveTokens({ access_token: "token", token_type: "Bearer" })
    await provider.commit()

    expect(entry?.discoveryState).toEqual(discoveryState)
  })
})
