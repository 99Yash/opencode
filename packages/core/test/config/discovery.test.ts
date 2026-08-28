import path from "path"
import { describe, expect } from "bun:test"
import { Config } from "@opencode-ai/core/config"
import { ConfigDiscovery } from "@opencode-ai/core/config/discovery"
import { Bus } from "@opencode-ai/core/bus"
import { Credential } from "@opencode-ai/core/credential"
import { Location } from "@opencode-ai/core/location"
import { Watcher } from "@opencode-ai/core/filesystem/watcher"
import { WellKnown } from "@opencode-ai/core/wellknown"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Event } from "@opencode-ai/schema/config"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/util/effect/layer-node"
import { FSUtil } from "@opencode-ai/util/fs-util"
import { Global } from "@opencode-ai/util/global"
import { Effect, Fiber, Layer, Stream } from "effect"
import { emptyCredentialNode, emptyWellknownNode } from "../fixture/config-nodes"
import { location } from "../fixture/location"
import { tmpdirScoped } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([FSUtil.node, Bus.node, Watcher.node, Credential.node, WellKnown.node]), [
    [Watcher.node, Watcher.testLayer],
    [Credential.node, emptyCredentialNode],
    [WellKnown.node, emptyWellknownNode],
  ]).pipe(Layer.merge(Watcher.testLayer)),
)

describe("ConfigDiscovery", () => {
  it.live("discovers and refreshes ordered entries without the Config service", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const fs = yield* FSUtil.Service
      const target = path.join(tmp.path, "custom.jsonc")
      yield* fs.writeFileString(target, '{ "shell": "before" }')
      yield* Effect.gen(function* () {
        const watcher = yield* Watcher.Test
        const bus = yield* Bus.Service
        const discovery: Config.Interface = yield* ConfigDiscovery.make({
          project: false,
          global: false,
          file: target,
          content: '{ "shell": "inline" }',
        })
        expect(Config.Options).toBe(ConfigDiscovery.Options)
        expect(yield* discovery.entries()).toMatchObject([
          { type: "document", path: target, info: { shell: "before" } },
          { type: "document", info: { shell: "inline" } },
        ])
        expect(yield* watcher.subscriptions()).toEqual([{ path: target, type: "file" }])
        const updated = yield* bus.subscribe(Event.Updated).pipe(
          Stream.take(1),
          Stream.mapEffect(() => discovery.entries()),
          Stream.runCollect,
          Effect.forkScoped({ startImmediately: true }),
        )
        const changed = yield* discovery
          .changes()
          .pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped({ startImmediately: true }))
        yield* fs.writeFileString(target, '{ "shell": "after" }')
        expect((yield* discovery.entries())[0]).toMatchObject({ info: { shell: "before" } })
        yield* watcher.emit({ path: target, type: "update" })
        expect(yield* Fiber.join(changed)).toEqual([{ path: target, type: "update" }])
        // The update event is a read barrier: its subscriber sees refreshed entries.
        expect(yield* Fiber.join(updated)).toMatchObject([
          [
            { type: "document", path: target, info: { shell: "after" } },
            { type: "document", info: { shell: "inline" } },
          ],
        ])
      }).pipe(
        Effect.provideService(Location.Service, location({ directory: AbsolutePath.make(tmp.path) })),
        Effect.provideService(Global.Service, Global.make({ config: path.join(tmp.path, "global"), home: tmp.path })),
      )
    }),
  )
})
