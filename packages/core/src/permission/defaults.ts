import path from "path"
import { Global } from "../global"
import { PermissionV2 } from "../permission"

// Combined output files written by the Shell service, e.g. `<data>/shell/<projectID>/<shellID>.out`.
export const SHELL_OUTPUT_GLOB = path.join(Global.Path.data, "shell", "*", "*")

export function allowExternalDirectories(resources: readonly string[]): PermissionV2.Ruleset {
  return resources.map((resource): PermissionV2.Rule => ({ action: "external_directory", resource, effect: "allow" }))
}
