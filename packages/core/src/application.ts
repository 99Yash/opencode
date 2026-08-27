export * as Application from "./application.js"
export { Options } from "./application/options.js"

import { Effect, Layer } from "effect"
import type { Options } from "./application/options.js"
import { LayerNode } from "@opencode-ai/util/effect/layer-node"
import type { Node } from "@opencode-ai/util/effect/app-node"
import { httpClient } from "@opencode-ai/util/effect/app-node-platform"
import { Global } from "@opencode-ai/util/global"
import { App } from "./app.js"
import { Bus } from "./bus.js"
import { Config } from "./config.js"
import { Credential } from "./credential.js"
import { Database } from "./database/database.js"
import { AppNodeBuilder } from "./effect/app-node-builder.js"
import { EventLogger } from "./event-logger.js"
import { FileSystemSearch } from "./filesystem/search.js"
import { Watcher } from "./filesystem/watcher.js"
import { InstructionDiscovery } from "./instruction-discovery.js"
import { Job } from "./job.js"
import { LocationActivity } from "./location-activity.js"
import { LocationServiceMap } from "./location-service-map.js"
import { MCP } from "./mcp/index.js"
import { ModelsDev } from "./models-dev.js"
import { PermissionSaved } from "./permission/saved.js"
import { PersistentPty } from "./persistent-pty.js"
import { PluginRuntime } from "./plugin/runtime.js"
import { SdkPlugins } from "./plugin/sdk.js"
import { Project } from "./project.js"
import { PtyTicket } from "./pty/ticket.js"
import { Session } from "./session.js"
import { SessionRestart } from "./session/execution/restart.js"
import { SessionTransfer } from "./session/transfer.js"
import { ShellSelect } from "./shell/select.js"
import { WellKnown } from "./wellknown.js"
import { Workspace } from "./workspace.js"
import { Worktree } from "./worktree.js"

const services = LayerNode.group([
  Global.node,
  Database.node,
  Bus.node,
  EventLogger.node,
  httpClient,
  Job.node,
  Project.node,
  Worktree.node,
  Session.node,
  SessionTransfer.node,
  SdkPlugins.node,
  PermissionSaved.node,
  PtyTicket.node,
  PersistentPty.node,
  Credential.node,
  WellKnown.node,
  LocationServiceMap.node,
  LocationActivity.node,
  SessionRestart.node,
  Workspace.node,
])

/** Build the standard application without choosing an HTTP or process host. */
export function layer<A = never, E = never>(
  options: Options = {},
  overrides: LayerNode.Replacements = [],
  extra?: Node.GlobalNode<A, E>,
) {
  return build(LayerNode.group([services, ...(extra ? [extra] : [])]), [
    [Database.node, Database.configured(options.database)],
    [Bus.node, Bus.configured({ persist: options.events?.persist })],
    [App.node, App.configured(options.app)],
    [ModelsDev.node, ModelsDev.configured(options.models)],
    [Watcher.node, Watcher.configured({ enabled: options.fs?.filewatcher })],
    [FileSystemSearch.node, FileSystemSearch.configured({ fff: options.fs?.fff })],
    [Global.node, Global.layerWith(options.config?.directory ? { config: options.config.directory } : {})],
    [Config.node, Config.configured(options.config)],
    [InstructionDiscovery.node, InstructionDiscovery.configured({ project: options.config?.project })],
    [ShellSelect.node, ShellSelect.configured({ gitbash: options.windows?.gitbash })],
    [
      MCP.node,
      MCP.configured({
        clientInfo: { name: options.app?.name ?? "opencode", version: options.app?.version ?? "unknown" },
      }),
    ],
    ...overrides,
  ])
}

/** Own the global-to-Location runtime connection, including for focused application fixtures. */
export function build<A, E>(root: Node.GlobalNode<A, E>, overrides: LayerNode.Replacements = []) {
  return Layer.effectContext(
    Effect.gen(function* () {
      const scope = yield* Effect.scope
      const memoMap = yield* Layer.makeMemoMap
      const cell = PluginRuntime.makeCell()
      // Location factories must capture this same map, not an enclosing host's map.
      return yield* Layer.buildWithMemoMap(
        AppNodeBuilder.build(LayerNode.group([root, PluginRuntime.providerNode]), [
          [PluginRuntime.node, PluginRuntime.layerWithCell(cell)],
          [PluginRuntime.providerNode, PluginRuntime.providerNodeWithCell(cell)],
          ...overrides,
        ]),
        memoMap,
        scope,
      )
    }),
  )
}
