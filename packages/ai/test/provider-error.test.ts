import { describe, expect, test } from "bun:test"
import { HttpContext, HttpRequestDetails, isContextOverflow } from "../src"
import { classifyProviderFailure } from "../src/provider-error"

describe("provider error classification", () => {
  test("classifies Z.AI GLM token limit messages as context overflow", () => {
    expect(isContextOverflow("tokens in request more than max tokens allowed")).toBe(true)
  })

  test("checks overflow evidence in the message when the response body is uninformative", () => {
    expect(
      classifyProviderFailure({
        message: "Input is too long for requested model",
        status: 400,
        http: new HttpContext({
          request: new HttpRequestDetails({ method: "POST", url: "https://provider.test", headers: {} }),
          body: "{}",
        }),
      }),
    ).toMatchObject({ classification: "context-overflow" })
  })

  test("lets semantic invalid-request codes override server status", () => {
    expect(classifyProviderFailure({ message: "too large", status: 500, code: "request_too_large" })._tag).toBe(
      "InvalidRequest",
    )
  })

  test("does not treat incidental safety text as a content-policy failure", () => {
    expect(classifyProviderFailure({ message: "Internal safety check failed", status: 500 })._tag).toBe(
      "ProviderInternal",
    )
    expect(classifyProviderFailure({ message: "Blocked by safety policy", status: 400 })._tag).toBe("ContentPolicy")
    expect(classifyProviderFailure({ message: "Blocked", status: 400, code: "SAFETY" })._tag).toBe("ContentPolicy")
  })

  test("classifies V1 plain-text rate limit fallbacks", () => {
    expect(
      [
        "Request rate increased too quickly",
        "Rate limit exceeded, please try again later",
        "Too many requests, please slow down",
      ].map((message) => classifyProviderFailure({ message })._tag),
    ).toEqual(["RateLimit", "RateLimit", "RateLimit"])
  })

  test("classifies V1 JSON rate limit fallbacks", () => {
    expect(
      [
        '{"type":"error","error":{"type":"too_many_requests"}}',
        '{"type":"error","error":{"code":"rate_limit_exceeded"}}',
        '{"code":"bad_request","error":{"code":"rate_limit_exceeded"}}',
        '{"type":"error","error":{"code":"unknown","type":"too_many_requests"}}',
      ].map((message) => classifyProviderFailure({ message })._tag),
    ).toEqual(["RateLimit", "RateLimit", "RateLimit", "RateLimit"])
  })

  test("classifies canonical provider retry codes", () => {
    expect(
      ['{"code":"resource_exhausted"}', '{"code":"service_unavailable"}'].map(
        (message) => classifyProviderFailure({ message })._tag,
      ),
    ).toEqual(["RateLimit", "ProviderInternal"])
  })

  test("keeps temporary per-minute quota wording retryable", () => {
    expect(classifyProviderFailure({ message: "You exceeded your per-minute quota", status: 429 })._tag).toBe(
      "RateLimit",
    )
  })

  test("classifies canonical Google error codes", () => {
    expect(
      ["UNAUTHENTICATED", "PERMISSION_DENIED", "INVALID_ARGUMENT", "NOT_FOUND", "INTERNAL"].map(
        (code) => classifyProviderFailure({ message: "Provider failed", code })._tag,
      ),
    ).toEqual(["Authentication", "Authentication", "InvalidRequest", "InvalidRequest", "ProviderInternal"])
  })

  test("classifies stripped Bedrock stream errors from their messages", () => {
    expect(
      ["Internal server error", "Throttling exception", "Validation error: invalid input"].map(
        (message) => classifyProviderFailure({ message })._tag,
      ),
    ).toEqual(["ProviderInternal", "RateLimit", "InvalidRequest"])
  })

  test("classifies documented Bedrock exception codes", () => {
    expect(
      ["accessDeniedException", "modelTimeoutException", "resourceNotFoundException"].map(
        (code) => classifyProviderFailure({ message: "Bedrock failed", code })._tag,
      ),
    ).toEqual(["Authentication", "ProviderInternal", "InvalidRequest"])
  })

  test("classifies Anthropic not-found stream errors as invalid requests", () => {
    expect(classifyProviderFailure({ message: "Model unavailable", code: "not_found_error" })._tag).toBe(
      "InvalidRequest",
    )
  })

  test("classifies nested provider codes when a top-level code is also present", () => {
    expect(
      [
        '{"code":"bad_request","error":{"code":"usage_not_included"}}',
        '{"code":"bad_request","error":{"code":"server_error"}}',
        '{"code":"bad_request","error":{"type":"invalid_request_error"}}',
        '{"type":"response.failed","response":{"error":{"code":"server_error"}}}',
      ].map((message) => classifyProviderFailure({ message })._tag),
    ).toEqual(["QuotaExceeded", "ProviderInternal", "InvalidRequest", "ProviderInternal"])
  })

  test("keeps unknown and malformed provider payloads non-retryable", () => {
    expect(classifyProviderFailure({ message: '{"error":{"message":"no_kv_space"}}' })._tag).toBe("UnknownProvider")
    expect(classifyProviderFailure({ message: '{"type":"error","error":{"code":123}}' })._tag).toBe("UnknownProvider")
    expect(classifyProviderFailure({ message: "not-json" })._tag).toBe("UnknownProvider")
  })
})
