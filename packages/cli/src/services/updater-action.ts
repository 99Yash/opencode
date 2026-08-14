import semver from "semver"
import type { Policy } from "./updater"

export type Action = "none" | "upgrade"

export function action(current: string, latest: string, policy: Policy): Action {
  if (policy === false) return "none"
  if (!semver.valid(current) || !semver.valid(latest) || semver.eq(latest, current)) return "none"
  // Major upgrades are never installed automatically.
  if (semver.major(latest) !== semver.major(current)) return "none"
  return "upgrade"
}
