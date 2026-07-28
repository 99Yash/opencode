import { expect, test } from "bun:test"
import { resolveSidecarVersion } from "./sidecar-version"

test("enables the v2 sidecar only for OPENCODE_SIDECAR_V2=1", () => {
  expect(resolveSidecarVersion("1")).toBe("v2")
  expect(resolveSidecarVersion("0")).toBe("v1")
  expect(resolveSidecarVersion(undefined)).toBe("v1")
})
