import type { DiscoverOptions } from "./service.js"
import semver from "semver"

export function matchesVersion(version: string | undefined, options: DiscoverOptions) {
  if (options.version === undefined) return true
  if (version === undefined) return false
  if (typeof options.version === "function") return options.version(version)
  return version === options.version
}

/** Whether a client version is strictly newer than a service version. */
export function canReplaceVersion(serverVersion: string | undefined, clientVersion: string) {
  if (serverVersion === undefined) return false
  // Compare preview build numbers numerically rather than as semver prerelease strings.
  const server = serverVersion.replace(/^(0\.0\.0-.+)-(\d+(?:\.\d+)?)$/, "$1.$2")
  const client = clientVersion.replace(/^(0\.0\.0-.+)-(\d+(?:\.\d+)?)$/, "$1.$2")
  if (!semver.valid(server) || !semver.valid(client)) return false
  return semver.lt(server, client)
}
