export * as PluginSupervisor from "./supervisor-service.js"

import { Context, Effect } from "effect"
import type { Plugin } from "@opencode-ai/schema/plugin"

/**
 * Dependency-only supervisor seam. Keep this module free of implementation
 * imports: the supervisor reaches PluginRuntime, which depends on Session.
 */
export interface Interface {
  /** Wait for the initial plugin generation and startup updates to settle. */
  readonly flush: Effect.Effect<void>
  /** Initial reconciliation barrier; it never closes again after startup settles. */
  readonly initialized: Effect.Effect<void>
  readonly check: (target: string) => Effect.Effect<Plugin.PackageStatus, Plugin.OperationError>
  readonly update: (target: string) => Effect.Effect<Plugin.Info[], Plugin.OperationError>
  readonly reload: (target: string) => Effect.Effect<Plugin.Info[], Plugin.OperationError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/PluginSupervisor") {}
