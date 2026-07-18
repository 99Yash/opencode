import { NodeFileSystem } from "@effect/platform-node"
import { Global } from "@opencode-ai/core/global"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { expect, test } from "bun:test"
import { Effect, FileSystem, Scope } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Config } from "../src/config"
import { ServerConnection } from "../src/services/server-connection"
import { ServiceConfig } from "../src/services/service-config"

test("resolution groups Effect-native lifecycle operations only for the managed service", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-server-resolution-"))
  const id = "server-resolution-test"
  const server = Bun.serve({
    port: 0,
    fetch() {
      return Response.json({
        healthy: true,
        version: InstallationVersion,
        pid: process.pid,
      })
    },
  })
  const registration = path.join(root, "state", ServiceConfig.filename())
  const layer = Global.layerWith({ config: path.join(root, "config"), state: path.join(root, "state") })
  const runPromise = <A, E>(
    effect: Effect.Effect<A, E, Global.Service | FileSystem.FileSystem | Scope.Scope | Config.Service>,
  ) =>
    Effect.runPromise(
      effect.pipe(
        Effect.provide(Config.layer),
        Effect.provide(layer),
        Effect.provide(NodeFileSystem.layer),
        Effect.scoped,
      ),
    )

  try {
    await fs.mkdir(path.dirname(registration), { recursive: true })
    await fs.writeFile(
      registration,
      JSON.stringify({
        id,
        version: InstallationVersion,
        url: server.url.toString(),
        pid: process.pid,
      }),
    )
    const resolved = await runPromise(ServerConnection.resolve({}))

    expect(resolved.endpoint.url).toBe(server.url.toString())
    expect(resolved.service).toBeDefined()
    if (!resolved.service) throw new Error("Expected managed service capabilities")
    expect(Effect.isEffect(resolved.service.reconnect())).toBe(true)
    expect(Effect.isEffect(resolved.service.restart())).toBe(true)
    expect(await runPromise(resolved.service.reconnect())).toEqual(resolved.endpoint)

    const explicit = await runPromise(ServerConnection.resolve({ server: server.url.toString() }))
    expect(explicit.endpoint.url).toBe(server.url.toString())
    expect(explicit.service).toBeUndefined()

    await runPromise(
      Effect.gen(function* () {
        const config = yield* Config.Service
        yield* config.update((draft) => {
          draft.servers = {
            mac: { url: server.url.toString(), username: "ryan", password: "secret" },
          }
        })
      }),
    )
    const saved = await runPromise(ServerConnection.resolve({ remote: "mac" }))
    expect(saved.endpoint).toEqual({
      url: server.url.toString(),
      auth: { type: "basic", username: "ryan", password: "secret" },
    })
    expect(saved.service).toBeUndefined()
  } finally {
    await server.stop(true)
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("reports an unknown saved server", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-server-profile-"))
  const layer = Global.layerWith({ config: path.join(root, "config"), state: path.join(root, "state") })

  try {
    const result = await Effect.runPromise(
      Effect.flip(ServerConnection.resolve({ remote: "missing" })).pipe(
        Effect.provide(Config.layer),
        Effect.provide(layer),
        Effect.provide(NodeFileSystem.layer),
        Effect.scoped,
      ),
    )
    expect(result.message).toBe('Saved server "missing" not found')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
