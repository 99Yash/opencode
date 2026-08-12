import type { DiscoverOptions } from "./service.js"
import semver from "semver"

export function matchesVersion(version: string | undefined, options: DiscoverOptions) {
  if (options.version === undefined) return true
  if (version === undefined) return false
  if (typeof options.version === "function") return options.version(version)
  return version === options.version
}

/** Whether a service is at least as new as its client. */
export function isServiceVersionCompatible(serverVersion: string, clientVersion: string) {
  if (serverVersion === clientVersion) return true
  const server = serverVersion.replace(/^(0\.0\.0-.+)-(\d+(?:\.\d+)?)$/, "$1.$2")
  const client = clientVersion.replace(/^(0\.0\.0-.+)-(\d+(?:\.\d+)?)$/, "$1.$2")
  if (!semver.valid(server) || !semver.valid(client)) return true
  return semver.gte(server, client)
}
