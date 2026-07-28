export function resolveSidecarVersion(value = process.env.OPENCODE_SIDECAR_V2) {
  return value === "1" ? "v2" : "v1"
}
