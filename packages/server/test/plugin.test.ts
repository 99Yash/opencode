import fs from "node:fs/promises"
import path from "node:path"
import { expect } from "bun:test"
import { Effect, Schema } from "effect"
import { Location } from "@opencode-ai/schema/location"
import { Plugin } from "@opencode-ai/schema/plugin"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { startServer } from "./fixture/server"

it.live("checks and reloads only configured sources, preserving working code after import and setup failures", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-plugin-endpoint-")))
    const global = path.join(tmp.path, "global")
    const project = path.join(tmp.path, "project")
    const target = path.join(project, "plugin.ts")
    const disabled = path.join(project, "disabled.ts")
    yield* Effect.promise(async () => {
      await fs.mkdir(global)
      await fs.mkdir(project)
      await fs.writeFile(target, `export default { id: "managed", tui: true, setup() {} }`)
      await fs.writeFile(
        disabled,
        `export default { id: "disabled", setup() { throw new Error("must remain disabled") } }`,
      )
      await fs.writeFile(
        path.join(project, "opencode.json"),
        JSON.stringify({ plugins: ["-*", target, disabled, "-disabled"] }),
      )
    })
    const server = yield* startServer(global)
    const invoke = (action: string, source: string) =>
      Effect.promise(async () => {
        const url = new URL(`/api/plugin/${action}`, server.base)
        url.searchParams.set("location[directory]", project)
        const response = await fetch(url, {
          method: "POST",
          headers: { ...server.headers, "content-type": "application/json" },
          body: JSON.stringify({ target: source }),
        })
        const body: unknown = await response.json()
        return { status: response.status, body }
      })
    const check = yield* invoke("check", target)
    expect(check.status).toBe(200)
    expect(Schema.decodeUnknownSync(Location.response(Plugin.PackageStatus))(check.body).data).toEqual({
      mutable: false,
    })
    const first = yield* invoke("reload", target)
    expect(first.status).toBe(200)
    const initial = Schema.decodeUnknownSync(Location.response(Schema.Array(Plugin.Info)))(first.body).data
    expect(initial).toEqual([
      expect.objectContaining({ id: "managed", status: "active", tui: true, generation: expect.any(String) }),
    ])

    yield* Effect.promise(() =>
      fs.writeFile(target, `export default { id: "managed", setup() { throw new Error("setup failed") } }`),
    )
    const setup = yield* invoke("reload", target)
    expect(setup.status).toBe(200)
    expect(Schema.decodeUnknownSync(Location.response(Schema.Array(Plugin.Info)))(setup.body).data).toEqual([
      { ...initial[0], error: expect.stringContaining("setup failed") },
    ])
    yield* Effect.promise(() =>
      fs.writeFile(target, `import "./missing.ts"; export default { id: "managed", setup() {} }`),
    )
    const imported = yield* invoke("reload", target)
    expect(imported.status).toBe(200)
    expect(Schema.decodeUnknownSync(Location.response(Schema.Array(Plugin.Info)))(imported.body).data).toEqual([
      { ...initial[0], error: expect.stringContaining("missing.ts") },
    ])
    yield* Effect.promise(() =>
      fs.writeFile(
        target,
        `export default { id: "changed-id", setup() { throw new Error("new setup must not run") } }`,
      ),
    )
    const renamed = yield* invoke("reload", target)
    expect(renamed.status).toBe(200)
    expect(Schema.decodeUnknownSync(Location.response(Schema.Array(Plugin.Info)))(renamed.body).data).toEqual([
      { ...initial[0], error: expect.stringContaining("Plugin ID changed from managed to changed-id") },
    ])
    const off = yield* invoke("reload", disabled)
    expect(off.status).toBe(200)
    expect(
      Schema.decodeUnknownSync(Location.response(Schema.Array(Plugin.Info)))(off.body).data.map((item) => item.id),
    ).toEqual([Plugin.ID.make("managed")])

    yield* Effect.promise(() => fs.writeFile(target, `export default { id: "managed", tui: true, setup() {} }`))
    const replacements = yield* Effect.all([invoke("reload", target), invoke("reload", target)], {
      concurrency: "unbounded",
    })
    const generations = replacements.map((result) => {
      expect(result.status).toBe(200)
      const info = Schema.decodeUnknownSync(Location.response(Schema.Array(Plugin.Info)))(result.body).data[0]
      expect(info?.status).toBe("active")
      expect(info?.error).toBeUndefined()
      return info?.generation
    })
    expect(new Set(generations).size).toBe(2)
    expect(generations).not.toContain(initial[0]?.generation)
    for (const operation of [
      { action: "update", source: target },
      { action: "reload", source: "opencode.agent" },
      { action: "update", source: "not-configured@latest" },
      { action: "check", source: "managed" },
    ]) {
      const rejected = yield* invoke(operation.action, operation.source)
      expect(rejected.status).toBe(400)
      expect(Schema.decodeUnknownSync(Plugin.OperationError)(rejected.body)._tag).toBe("PluginOperationError")
    }
  }),
)
