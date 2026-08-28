import { expect, spyOn, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { Effect, FileSystem } from "effect"
import { Global } from "@opencode-ai/util/global"
import { cp, mkdir, readFile, symlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { createEventStream, createFetch, json, type FetchHandler } from "./fixture/tui-client"
import { tmpdir } from "./fixture/fixture"
import { noPackages } from "./fixture/tui-packages"
import type { PackageResolver, usePlugin } from "../src/plugin/context"
import type { Config } from "../src/config"

function lifecyclePluginSource(marker: string, id: string, version: string) {
  return `
export default {
  id: ${JSON.stringify(id)},
  setup: async () => {
    await appendFile(${JSON.stringify(marker)}, "${version}:setup\\n")
    return () => appendFile(${JSON.stringify(marker)}, "${version}:cleanup\\n")
  },
}
`
}

function lifecycleSource(marker: string, id: string, version: string) {
  return `
import { appendFile } from "node:fs/promises"
${lifecyclePluginSource(marker, id, version)}
`
}

function gatedLifecycleSource(marker: string, ready: string, gate: string, id: string, version: string) {
  return `
import { access, appendFile } from "node:fs/promises"
await appendFile(${JSON.stringify(ready)}, "ready\\n")
while (true) {
  try {
    await access(${JSON.stringify(gate)})
    break
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
${lifecyclePluginSource(marker, id, version)}
`
}

async function until(read: () => Promise<string>, expected: (value: string | undefined) => boolean) {
  let value: string | undefined
  for (let attempt = 0; attempt < 200; attempt++) {
    value = await read().catch(() => undefined)
    if (expected(value)) return value
    await Bun.sleep(50)
  }
  return value
}

async function bootApp(
  directory: string,
  options?: {
    plugins?: unknown[]
    resolve?: (spec: string, install?: boolean) => Promise<string | undefined>
    packages?: Partial<PackageResolver>
    config?: Config.Info
    fetch?: FetchHandler
  },
) {
  const setup = await createTestRenderer({ width: 80, height: 24, useThread: false })
  const pluginContext = await import("../src/plugin/context")
  const original = pluginContext.usePlugin
  let plugin: ReturnType<typeof usePlugin> | undefined
  const probe = spyOn(pluginContext, "usePlugin").mockImplementation(() => {
    plugin = original()
    return plugin
  })
  let plugins = options?.plugins ?? []
  const events = createEventStream()
  const calls = createFetch(async (url, request) => {
    const response = await options?.fetch?.(url, request)
    if (response) return response
    if (url.pathname === "/api/plugin")
      return json({
        location: {
          directory,
          project: { id: "proj_test", directory, canonical: directory },
        },
        data: plugins,
      })
    if (url.pathname !== "/api/fs/list") return
    return json({
      location: {
        directory,
        project: { id: "proj_test", directory, canonical: directory },
      },
      data: [],
    })
  }, events)
  const server = Bun.serve({ port: 0, fetch: (request) => calls.fetch(request) })
  const cwd = process.cwd()
  process.chdir(directory)
  const { run } = await import("../src/app")
  const task = Effect.runPromise(
    run({
      app: { name: "test", version: "test", channel: "test" },
      server: { endpoint: { url: server.url.toString() } },
      config: { get: async () => options?.config ?? {}, update: async () => options?.config ?? {} },
      packages: { ...noPackages, resolve: options?.resolve ?? noPackages.resolve, ...options?.packages },
      terminalHandoff: async () => ({ renderer: setup.renderer, mode: "dark", complete: () => {} }),
      args: {},
      log: () => {},
    }).pipe(
      Effect.provide(
        Global.layerWith({
          home: directory,
          config: path.join(directory, ".global"),
          data: path.join(directory, ".data"),
          state: path.join(directory, ".state"),
          cache: path.join(directory, ".cache"),
          tmp: path.join(directory, ".tmp"),
          bin: path.join(directory, ".bin"),
          log: path.join(directory, ".log"),
          repos: path.join(directory, ".repos"),
        }),
      ),
      Effect.provide(FileSystem.layerNoop({})),
    ),
  )
  return {
    task,
    plugin() {
      if (!plugin) throw new Error("PluginProvider has not mounted")
      return plugin
    },
    inventory(next: unknown[], notify = true) {
      plugins = next
      if (notify) events.emit({ id: "evt_plugin", created: Date.now(), type: "plugin.updated", data: {} })
    },
    async [Symbol.asyncDispose]() {
      process.chdir(cwd)
      if (!setup.renderer.isDestroyed) setup.renderer.destroy()
      await server.stop()
      probe.mockRestore()
    },
  }
}

function companion(revision: string, generation = `server-${revision}`) {
  return [
    {
      id: "test.server",
      source: { type: "package", package: "test-plugin@latest" },
      status: "active",
      tui: true,
      revision,
      generation,
    },
  ]
}

async function fixturePackages(directory: string, marker: string) {
  type Graph = { directory: string; entrypoint: string; revision: string; generation: string }
  const graphs = new Map<string, Graph>()
  const generations = new Map<string, Graph>()
  const calls: Array<{ operation: string; spec: string; install?: boolean; revision?: string; generation?: string }> =
    []
  let current = "1.0.0"
  let available = "2.0.0"
  let generation = 0
  const graph = (revision: string) => {
    const result = graphs.get(revision)
    if (!result) throw new Error(`Missing fixture revision ${revision}`)
    return result
  }
  const publish = async (revision: string, source?: string, options?: { generation?: string; dependency?: string }) => {
    const root = path.join(directory, "cache", options?.generation ?? revision)
    await mkdir(root, { recursive: true })
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ type: "module", name: "test-plugin", version: revision }),
    )
    await writeFile(
      path.join(root, "version.ts"),
      `export const version = ${JSON.stringify(options?.dependency ?? revision)}`,
    )
    await writeFile(
      path.join(root, "tui.ts"),
      source ??
        `
import { appendFile } from "node:fs/promises"
import { version } from "./version"
await appendFile(${JSON.stringify(marker)}, version + ":import\\n")
export default {
  id: "test.package",
  setup: async () => {
    await appendFile(${JSON.stringify(marker)}, version + ":setup\\n")
    return () => appendFile(${JSON.stringify(marker)}, version + ":cleanup\\n")
  },
}
`,
    )
    const result = {
      directory: root,
      entrypoint: pathToFileURL(path.join(root, "tui.ts")).href,
      revision,
      generation: options?.generation ?? `local-${revision}`,
    }
    graphs.set(revision, result)
    generations.set(result.generation, result)
  }
  await Promise.all(["1.0.0", "2.0.0", "3.0.0"].map((revision) => publish(revision)))
  const packages: PackageResolver = {
    resolve: async (spec, install, revision) => {
      calls.push({ operation: "resolve", spec, install, revision })
      return graph(revision ?? current)
    },
    check: async (spec) => {
      calls.push({ operation: "check", spec })
      return { installed: current, available, mutable: true }
    },
    update: async (spec) => {
      calls.push({ operation: "update", spec })
      current = available
      return graph(current)
    },
    reload: async (spec, options) => {
      calls.push({ operation: "reload", spec, ...options })
      const previous = options?.generation ? generations.get(options.generation) : graph(options?.revision ?? current)
      if (!previous) throw new Error(`Missing fixture generation ${options?.generation}`)
      const root = `${previous.directory}-reload-${++generation}`
      await cp(previous.directory, root, { recursive: true })
      const result = {
        directory: root,
        entrypoint: pathToFileURL(path.join(root, "tui.ts")).href,
        revision: previous.revision,
        generation: `local-reload-${generation}`,
      }
      generations.set(result.generation, result)
      return result
    },
  }
  return {
    packages,
    calls,
    publish,
    current: (revision: string) => {
      current = revision
    },
    available: (revision: string) => {
      available = revision
    },
  }
}

test("companion inventory imports the exact server revision and sync awaits its new dependency graph", async () => {
  await using tmp = await tmpdir()
  const marker = path.join(tmp.path, "marker.txt")
  const fixture = await fixturePackages(tmp.path, marker)
  fixture.current("3.0.0")
  await using app = await bootApp(tmp.path, { plugins: companion("1.0.0"), packages: fixture.packages })
  const read = () => readFile(marker, "utf8")
  expect(await until(read, (value) => value?.includes("1.0.0:setup") ?? false)).toBe("1.0.0:import\n1.0.0:setup\n")
  expect(fixture.calls).toContainEqual({
    operation: "resolve",
    spec: "test-plugin@latest",
    install: true,
    revision: "1.0.0",
  })
  expect(app.plugin().list()).toContainEqual({
    target: "test-plugin@latest",
    id: "test.package",
    status: "active",
    revision: "1.0.0",
    generation: "local-1.0.0",
    error: undefined,
  })

  app.inventory(companion("2.0.0"))
  expect(await until(read, (value) => value?.includes("2.0.0:setup") ?? false)).toBe(
    "1.0.0:import\n1.0.0:setup\n2.0.0:import\n1.0.0:cleanup\n2.0.0:setup\n",
  )
  expect(app.plugin().list()[0]?.revision).toBe("2.0.0")

  app.inventory(companion("3.0.0"), false)
  await app.plugin().sync()
  expect(await read()).toEndWith("3.0.0:import\n2.0.0:cleanup\n3.0.0:setup\n")
  expect(app.plugin().list()[0]?.revision).toBe("3.0.0")
  const before = await read()
  await app.plugin().sync()
  expect(await read()).toBe(before)

  process.emit("SIGHUP")
  await app.task
  expect(await read()).toBe(`${before}3.0.0:cleanup\n`)
})

test("a server generation change reloads the same revision from a fresh local graph without moving ahead", async () => {
  await using tmp = await tmpdir()
  const marker = path.join(tmp.path, "marker.txt")
  const fixture = await fixturePackages(tmp.path, marker)
  fixture.current("3.0.0")
  await using app = await bootApp(tmp.path, { plugins: companion("1.0.0"), packages: fixture.packages })
  const read = () => readFile(marker, "utf8")
  await until(read, (value) => value?.includes("1.0.0:setup") ?? false)
  const unregister = app.plugin().slots.register("app")
  const builtin = app
    .plugin()
    .slots.resolved()
    .slotted.get("app")
    ?.append.find((claim) => claim.plugin === "opencode.plugins")
  expect(builtin).toBeDefined()

  app.inventory(companion("1.0.0", "server-reload"), false)
  await app.plugin().sync()
  expect(await read()).toBe("1.0.0:import\n1.0.0:setup\n1.0.0:import\n1.0.0:cleanup\n1.0.0:setup\n")
  expect(fixture.calls.filter((call) => call.operation === "reload")).toEqual([
    { operation: "reload", spec: "test-plugin@latest", revision: "1.0.0" },
  ])
  expect(app.plugin().list()[0]?.generation).toBe("local-reload-1")
  expect(
    app
      .plugin()
      .slots.resolved()
      .slotted.get("app")
      ?.append.find((claim) => claim.plugin === "opencode.plugins"),
  ).toBe(builtin)
  const before = await read()
  await app.plugin().sync()
  expect(await read()).toBe(before)
  unregister()
  process.emit("SIGHUP")
  await app.task
})

test("resolution, import, and setup failures retain the loaded companion revision and surface its last error", async () => {
  await using tmp = await tmpdir()
  const marker = path.join(tmp.path, "marker.txt")
  const fixture = await fixturePackages(tmp.path, marker)
  await fixture.publish("broken-import", "export default {")
  await fixture.publish(
    "broken-setup",
    `
export default {
  id: "test.package",
  setup: async () => { throw new Error("setup boom") },
}
`,
  )
  await using app = await bootApp(tmp.path, { plugins: companion("1.0.0"), packages: fixture.packages })
  const read = () => readFile(marker, "utf8")
  expect(await until(read, (value) => value?.includes("1.0.0:setup") ?? false)).toBe("1.0.0:import\n1.0.0:setup\n")
  for (const revision of ["missing", "broken-import", "broken-setup"]) {
    app.inventory(companion(revision), false)
    await app.plugin().sync()
    expect(app.plugin().list()[0]).toMatchObject({ status: "active", revision: "1.0.0", generation: "local-1.0.0" })
    const state = app.plugin().list()[0]
    expect(state && "error" in state && state.error).toBeTruthy()
    const before = await read()
    await app.plugin().sync()
    expect(await read()).toBe(before)
  }
  expect(await read()).toBe("1.0.0:import\n1.0.0:setup\n1.0.0:cleanup\n1.0.0:setup\n")
  app.inventory(companion("2.0.0"), false)
  await app.plugin().sync()
  expect(app.plugin().list()[0]).toMatchObject({ status: "active", revision: "2.0.0", error: undefined })
  process.emit("SIGHUP")
  await app.task
})

test("rejects a companion resolver returning a different revision before touching the running instance", async () => {
  await using tmp = await tmpdir()
  const marker = path.join(tmp.path, "marker.txt")
  const fixture = await fixturePackages(tmp.path, marker)
  await using app = await bootApp(tmp.path, {
    plugins: companion("1.0.0"),
    packages: {
      ...fixture.packages,
      resolve: (spec, install, revision) =>
        fixture.packages.resolve(spec, install, revision === "2.0.0" ? "3.0.0" : revision),
    },
  })
  const read = () => readFile(marker, "utf8")
  await until(read, (value) => value?.includes("1.0.0:setup") ?? false)
  const before = await read()
  app.inventory(companion("2.0.0"), false)
  await app.plugin().sync()
  expect(await read()).toBe(before)
  expect(app.plugin().list()[0]).toMatchObject({
    status: "active",
    revision: "1.0.0",
    error: "TUI companion revision does not match server revision 2.0.0: test-plugin@latest",
  })
  process.emit("SIGHUP")
  await app.task
})

test("per-window companion disables survive revision updates and same-revision reloads", async () => {
  await using tmp = await tmpdir()
  const marker = path.join(tmp.path, "marker.txt")
  const fixture = await fixturePackages(tmp.path, marker)
  await using app = await bootApp(tmp.path, { plugins: companion("1.0.0"), packages: fixture.packages })
  const read = () => readFile(marker, "utf8")
  await until(read, (value) => value?.includes("1.0.0:setup") ?? false)
  expect(await app.plugin().deactivate("test.package")).toBe(true)
  app.inventory(companion("2.0.0"), false)
  await app.plugin().sync()
  expect(app.plugin().list()[0]).toMatchObject({ status: "inactive", revision: "2.0.0" })
  app.inventory(companion("2.0.0", "server-reload"), false)
  await app.plugin().sync()
  expect(app.plugin().list()[0]).toMatchObject({ status: "inactive", revision: "2.0.0", generation: "local-reload-1" })
  expect(await read()).toBe("1.0.0:import\n1.0.0:setup\n1.0.0:cleanup\n2.0.0:import\n2.0.0:import\n")
  expect(await app.plugin().activate("test.package")).toBe(true)
  expect(await read()).toEndWith("2.0.0:setup\n")
  process.emit("SIGHUP")
  await app.task
})

test("config-disabled companions never activate a newer duplicate CLI package during startup or refresh", async () => {
  await using tmp = await tmpdir()
  const marker = path.join(tmp.path, "marker.txt")
  const fixture = await fixturePackages(tmp.path, marker)
  fixture.current("3.0.0")
  await using app = await bootApp(tmp.path, {
    plugins: companion("1.0.0"),
    packages: fixture.packages,
    config: { plugins: ["test-plugin@latest", "-test.package"] },
  })
  const read = () => readFile(marker, "utf8")
  expect(await until(read, (value) => value?.includes("1.0.0:import") ?? false)).toBe("1.0.0:import\n")
  await app.plugin().sync()
  expect(app.plugin().list()[0]).toMatchObject({ status: "inactive", revision: "1.0.0" })
  app.inventory(companion("2.0.0"), false)
  await app.plugin().sync()
  expect(app.plugin().list()[0]).toMatchObject({ status: "inactive", revision: "2.0.0" })
  expect(await read()).toBe("1.0.0:import\n2.0.0:import\n")
  expect(
    fixture.calls.filter((call) => call.operation === "resolve").every((call) => call.revision !== undefined),
  ).toBe(true)
  process.emit("SIGHUP")
  await app.task
})

test("CLI-only package management reloads a fresh graph, updates locally, and retains manual disables", async () => {
  await using tmp = await tmpdir()
  const marker = path.join(tmp.path, "marker.txt")
  const fixture = await fixturePackages(tmp.path, marker)
  await using app = await bootApp(tmp.path, { packages: fixture.packages, config: { plugins: ["test-plugin@latest"] } })
  const read = () => readFile(marker, "utf8")
  await until(read, (value) => value?.includes("1.0.0:setup") ?? false)
  expect(await app.plugin().check("test-plugin@latest")).toEqual({
    installed: "1.0.0",
    available: "2.0.0",
    mutable: true,
  })
  await app.plugin().reload("test-plugin@latest")
  expect(await read()).toBe("1.0.0:import\n1.0.0:setup\n1.0.0:import\n1.0.0:cleanup\n1.0.0:setup\n")
  expect(app.plugin().list()[0]?.generation).toBe("local-reload-1")
  expect(fixture.calls.filter((call) => call.operation === "resolve")).toHaveLength(1)
  await app.plugin().deactivate("test.package")
  await app.plugin().update("test-plugin@latest")
  await app.plugin().reload("test-plugin@latest")
  await app.plugin().sync()
  expect(app.plugin().list()[0]).toMatchObject({ status: "inactive", revision: "2.0.0", generation: "local-reload-2" })
  expect(await read()).toEndWith("1.0.0:cleanup\n2.0.0:import\n2.0.0:import\n")
  expect(fixture.calls.filter((call) => call.operation === "update")).toHaveLength(1)
  process.emit("SIGHUP")
  await app.task
})

test("disabled replacements keep the last successfully enabled graph for failed-enable and reload recovery", async () => {
  await using tmp = await tmpdir()
  const marker = path.join(tmp.path, "marker.txt")
  const fixture = await fixturePackages(tmp.path, marker)
  await fixture.publish(
    "2.0.0",
    `
import { appendFile } from "node:fs/promises"
export default {
  id: "test.package",
  setup: async () => {
    await appendFile(${JSON.stringify(marker)}, "2.0.0:attempt\\n")
    throw new Error("disabled replacement boom")
  },
}
`,
  )
  await using app = await bootApp(tmp.path, { packages: fixture.packages, config: { plugins: ["test-plugin@latest"] } })
  const read = () => readFile(marker, "utf8")
  expect(await until(read, (value) => value?.includes("1.0.0:setup") ?? false)).toBe("1.0.0:import\n1.0.0:setup\n")
  await app.plugin().deactivate("test.package")
  await app.plugin().update("test-plugin@latest")
  expect(app.plugin().list()[0]).toMatchObject({ status: "inactive", revision: "2.0.0", error: undefined })
  expect(await read()).toBe("1.0.0:import\n1.0.0:setup\n1.0.0:cleanup\n")
  await expect(app.plugin().activate("test.package")).rejects.toThrow("disabled replacement boom")
  expect(app.plugin().list()[0]).toMatchObject({
    status: "failed",
    revision: "1.0.0",
    generation: "local-1.0.0",
    error: "disabled replacement boom",
  })
  expect(app.plugin().registered()).toContainEqual({ id: "test.package", source: "external", active: false })
  await app.plugin().sync()
  expect(await read()).toBe("1.0.0:import\n1.0.0:setup\n1.0.0:cleanup\n2.0.0:attempt\n")
  expect(app.plugin().list()[0]).toMatchObject({ revision: "1.0.0", error: "disabled replacement boom" })

  await app.plugin().reload("test-plugin@latest")
  expect(fixture.calls.filter((call) => call.operation === "reload")).toEqual([
    { operation: "reload", spec: "test-plugin@latest", revision: "1.0.0", generation: "local-1.0.0" },
  ])
  expect(app.plugin().list()[0]).toMatchObject({ status: "inactive", revision: "1.0.0", generation: "local-reload-1" })
  const reloaded = app.plugin().list()[0]
  expect(reloaded && "error" in reloaded ? reloaded.error : undefined).toBeUndefined()
  expect(await app.plugin().activate("test.package")).toBe(true)
  expect(app.plugin().list()[0]).toMatchObject({ status: "active", revision: "1.0.0" })

  await app.plugin().deactivate("test.package")
  fixture.available("3.0.0")
  await app.plugin().update("test-plugin@latest")
  expect(app.plugin().list()[0]).toMatchObject({ status: "inactive", revision: "3.0.0" })
  expect(await app.plugin().activate("test.package")).toBe(true)
  await app.plugin().deactivate("test.package")
  fixture.available("2.0.0")
  await app.plugin().update("test-plugin@latest")
  await expect(app.plugin().activate("test.package")).rejects.toThrow("disabled replacement boom")
  expect(app.plugin().list()[0]).toMatchObject({
    status: "failed",
    revision: "3.0.0",
    generation: "local-3.0.0",
    error: "disabled replacement boom",
  })
  expect(app.plugin().registered()).toContainEqual({ id: "test.package", source: "external", active: false })
  process.emit("SIGHUP")
  await app.task
})

test("rejects exported ID changes before replacing active or disabled registrations", async () => {
  await using tmp = await tmpdir()
  const marker = path.join(tmp.path, "marker.txt")
  const fixture = await fixturePackages(tmp.path, marker)
  await fixture.publish(
    "2.0.0",
    `
import { appendFile } from "node:fs/promises"
export default {
  id: "test.renamed",
  setup: async () => {
    await appendFile(${JSON.stringify(marker)}, "renamed:attempt\\n")
    throw new Error("renamed setup boom")
  },
}
`,
  )
  await using app = await bootApp(tmp.path, { packages: fixture.packages, config: { plugins: ["test-plugin@latest"] } })
  const read = () => readFile(marker, "utf8")
  expect(await until(read, (value) => value?.includes("1.0.0:setup") ?? false)).toBe("1.0.0:import\n1.0.0:setup\n")
  const error = "Plugin ID cannot change for test-plugin@latest: test.package -> test.renamed"
  await expect(app.plugin().update("test-plugin@latest")).rejects.toThrow(error)
  expect(app.plugin().list()[0]).toMatchObject({ id: "test.package", status: "active", revision: "1.0.0", error })
  expect(await read()).toBe("1.0.0:import\n1.0.0:setup\n")
  await app.plugin().deactivate("test.package")
  await expect(app.plugin().update("test-plugin@latest")).rejects.toThrow(error)
  expect(app.plugin().list()[0]).toMatchObject({ id: "test.package", revision: "1.0.0", error })
  expect(app.plugin().registered()).toContainEqual({ id: "test.package", source: "external", active: false })
  expect(
    app
      .plugin()
      .registered()
      .some((plugin) => plugin.id === "test.renamed"),
  ).toBe(false)
  expect(await read()).toBe("1.0.0:import\n1.0.0:setup\n1.0.0:cleanup\n")
  process.emit("SIGHUP")
  await app.task
})

test("manual package reload copies the retained generation after a same-revision dependency update fails", async () => {
  await using tmp = await tmpdir()
  const marker = path.join(tmp.path, "marker.txt")
  const fixture = await fixturePackages(tmp.path, marker)
  await using app = await bootApp(tmp.path, { packages: fixture.packages, config: { plugins: ["test-plugin@latest"] } })
  const read = () => readFile(marker, "utf8")
  expect(await until(read, (value) => value?.includes("1.0.0:setup") ?? false)).toBe("1.0.0:import\n1.0.0:setup\n")
  await fixture.publish(
    "1.0.0",
    `
import { appendFile } from "node:fs/promises"
import { version } from "./version"
await appendFile(${JSON.stringify(marker)}, version + ":import\\n")
export default {
  id: "test.package",
  setup: async () => {
    await appendFile(${JSON.stringify(marker)}, version + ":attempt\\n")
    throw new Error("dependency setup boom")
  },
}
`,
    { generation: "new-dependencies", dependency: "dependency-1.1.0" },
  )
  fixture.available("1.0.0")
  await expect(app.plugin().update("test-plugin@latest")).rejects.toThrow("dependency setup boom")
  expect(app.plugin().list()[0]).toMatchObject({
    status: "active",
    revision: "1.0.0",
    generation: "local-1.0.0",
    error: "dependency setup boom",
  })
  expect(await read()).toBe(
    "1.0.0:import\n1.0.0:setup\ndependency-1.1.0:import\n1.0.0:cleanup\ndependency-1.1.0:attempt\n1.0.0:setup\n",
  )
  await app.plugin().reload("test-plugin@latest")
  expect(fixture.calls.filter((call) => call.operation === "reload")).toEqual([
    { operation: "reload", spec: "test-plugin@latest", revision: "1.0.0", generation: "local-1.0.0" },
  ])
  expect(app.plugin().list()[0]).toMatchObject({
    status: "active",
    revision: "1.0.0",
    generation: "local-reload-1",
    error: undefined,
  })
  expect(await read()).toEndWith("1.0.0:import\n1.0.0:cleanup\n1.0.0:setup\n")
  const before = await read()
  await app.plugin().sync()
  expect(await read()).toBe(before)
  process.emit("SIGHUP")
  await app.task
})

test("unchanged inventory syncs retain failed package resolutions until an explicit update", async () => {
  await using tmp = await tmpdir()
  const marker = path.join(tmp.path, "marker.txt")
  const fixture = await fixturePackages(tmp.path, marker)
  let attempts = 0
  await using app = await bootApp(tmp.path, {
    config: { plugins: ["test-plugin@latest"] },
    packages: {
      ...fixture.packages,
      resolve: async () => {
        attempts++
        throw new Error("fixture package unavailable")
      },
    },
  })
  expect(
    await until(
      async () => String(app.plugin().ready()),
      (value) => value === "true",
    ),
  ).toBe("true")
  await app.plugin().sync()
  await app.plugin().sync()
  expect(attempts).toBe(1)
  expect(app.plugin().list()[0]).toMatchObject({ status: "failed", error: "fixture package unavailable" })
  await app.plugin().update("test-plugin@latest")
  expect(app.plugin().list()[0]).toMatchObject({ status: "active", revision: "2.0.0", error: undefined })
  expect(await readFile(marker, "utf8")).toContain("2.0.0:setup")
  process.emit("SIGHUP")
  await app.task
})

test("a failed CLI-only update reports failure while keeping its old graph and can recover on retry", async () => {
  await using tmp = await tmpdir()
  const marker = path.join(tmp.path, "marker.txt")
  const fixture = await fixturePackages(tmp.path, marker)
  await using app = await bootApp(tmp.path, { packages: fixture.packages, config: { plugins: ["test-plugin@latest"] } })
  const read = () => readFile(marker, "utf8")
  await until(read, (value) => value?.includes("1.0.0:setup") ?? false)
  const before = await read()
  fixture.available("missing")
  await expect(app.plugin().update("test-plugin@latest")).rejects.toThrow("Missing fixture revision missing")
  await app.plugin().sync()
  expect(app.plugin().list()[0]).toMatchObject({
    status: "active",
    revision: "1.0.0",
    error: "Missing fixture revision missing",
  })
  expect(await read()).toBe(before)
  await app.plugin().reload("test-plugin@latest")
  expect(app.plugin().list()[0]).toMatchObject({
    status: "active",
    revision: "1.0.0",
    generation: "local-reload-1",
    error: undefined,
  })
  expect(fixture.calls.filter((call) => call.operation === "reload")).toEqual([
    { operation: "reload", spec: "test-plugin@latest", revision: "1.0.0", generation: "local-1.0.0" },
  ])
  fixture.available("2.0.0")
  await app.plugin().update("test-plugin@latest")
  expect(app.plugin().list()[0]).toMatchObject({ status: "active", revision: "2.0.0", error: undefined })
  process.emit("SIGHUP")
  await app.task
})

test("companion management delegates check/update/reload to the server and then awaits exact local reconciliation", async () => {
  await using tmp = await tmpdir()
  const marker = path.join(tmp.path, "marker.txt")
  const fixture = await fixturePackages(tmp.path, marker)
  fixture.current("3.0.0")
  const operations: Array<{ path: string; body: unknown }> = []
  const location = { directory: tmp.path, project: { id: "proj_test", directory: tmp.path, canonical: tmp.path } }
  await using app = await bootApp(tmp.path, {
    plugins: companion("1.0.0"),
    packages: fixture.packages,
    fetch: async (url, request) => {
      if (!["/api/plugin/check", "/api/plugin/update", "/api/plugin/reload"].includes(url.pathname)) return
      operations.push({ path: url.pathname, body: await request.json() })
      if (url.pathname.endsWith("/check"))
        return json({ location, data: { installed: "1.0.0", available: "2.0.0", mutable: true } })
      const plugins = companion("2.0.0", url.pathname.endsWith("/reload") ? "server-reload" : "server-2.0.0")
      app.inventory(plugins)
      return json({ location, data: plugins })
    },
  })
  const read = () => readFile(marker, "utf8")
  await until(read, (value) => value?.includes("1.0.0:setup") ?? false)
  expect(await app.plugin().check("test-plugin@latest")).toEqual({
    installed: "1.0.0",
    available: "2.0.0",
    mutable: true,
  })
  await app.plugin().update("test-plugin@latest")
  expect(app.plugin().list()[0]?.revision).toBe("2.0.0")
  await app.plugin().reload("test-plugin@latest")
  expect(app.plugin().list()[0]).toMatchObject({ revision: "2.0.0", generation: "local-reload-1" })
  expect(operations.map((operation) => operation.path)).toEqual([
    "/api/plugin/check",
    "/api/plugin/update",
    "/api/plugin/reload",
  ])
  expect(operations.every((operation) => JSON.stringify(operation.body).includes("test-plugin@latest"))).toBe(true)
  expect(fixture.calls.some((call) => call.operation === "check" || call.operation === "update")).toBe(false)
  expect(fixture.calls.filter((call) => call.operation === "reload")).toEqual([
    { operation: "reload", spec: "test-plugin@latest", revision: "2.0.0" },
  ])
  expect(await read()).not.toContain("3.0.0")
  process.emit("SIGHUP")
  await app.task
})

test("manual local-file reload reruns an unchanged source under a fresh generation without package operations", async () => {
  await using tmp = await tmpdir()
  const marker = path.join(tmp.path, "marker.txt")
  const source = path.join(tmp.path, "local.ts")
  await writeFile(
    source,
    `
import { appendFile } from "node:fs/promises"
await appendFile(${JSON.stringify(marker)}, "import\\n")
${lifecyclePluginSource(marker, "test.local", "local")}
`,
  )
  await using app = await bootApp(tmp.path, { config: { plugins: [source] } })
  const read = () => readFile(marker, "utf8")
  await until(read, (value) => value?.includes("local:setup") ?? false)
  const generation = app.plugin().list()[0]?.generation
  expect(await app.plugin().check(source)).toEqual({ mutable: false })
  await app.plugin().reload(source)
  expect(app.plugin().list()[0]?.generation).not.toBe(generation)
  expect(await read()).toBe("import\nlocal:setup\nimport\nlocal:cleanup\nlocal:setup\n")
  process.emit("SIGHUP")
  await app.task
})

test("loads an advertised package TUI entrypoint only from the local cache", async () => {
  await using tmp = await tmpdir()
  const marker = path.join(tmp.path, "marker.txt")
  const entrypoint = path.join(tmp.path, "tui.ts")
  await writeFile(entrypoint, lifecycleSource(marker, "test.package", "package"))
  const resolutions: Array<{ spec: string; install?: boolean }> = []

  await using app = await bootApp(tmp.path, {
    plugins: [
      {
        id: "test.server",
        source: { type: "package", package: "test-plugin@1.0.0" },
        status: "active",
        tui: true,
      },
    ],
    resolve: async (spec, install) => {
      resolutions.push({ spec, install })
      return pathToFileURL(entrypoint).href
    },
  })

  expect(
    await until(
      () => readFile(marker, "utf8"),
      (value) => value === "package:setup\n",
    ),
  ).toBe("package:setup\n")
  expect(resolutions).toContainEqual({ spec: "test-plugin@1.0.0", install: false })

  process.emit("SIGHUP")
  await app.task
})

test("discovers an ancestor TUI plugin directory created after startup", async () => {
  await using tmp = await tmpdir()
  const cwd = path.join(tmp.path, "repo", "packages", "app")
  await mkdir(cwd, { recursive: true })
  await mkdir(path.join(tmp.path, "repo", ".git"))
  const ready = path.join(tmp.path, "ready.txt")
  const marker = path.join(tmp.path, "marker.txt")
  const initial = path.join(cwd, ".opencode", "plugins", "tui")
  await mkdir(initial, { recursive: true })
  await writeFile(path.join(initial, "ready.ts"), lifecycleSource(ready, "test.ready", "ready"))

  await using app = await bootApp(cwd)
  expect(
    await until(
      () => readFile(ready, "utf8"),
      (value) => value === "ready:setup\n",
    ),
  ).toBe("ready:setup\n")
  const directory = path.join(tmp.path, "repo", ".opencode", "plugins", "tui")
  await mkdir(directory, { recursive: true })
  await writeFile(path.join(directory, "hot.ts"), lifecycleSource(marker, "test.hot", "v1"))

  expect(
    await until(
      () => readFile(marker, "utf8"),
      (value) => value === "v1:setup\n",
    ),
  ).toBe("v1:setup\n")

  process.emit("SIGHUP")
  await app.task
})

test("editing a discovered TUI plugin hot-reloads its fresh module", async () => {
  await using tmp = await tmpdir()
  const directory = path.join(tmp.path, ".opencode", "plugins", "tui")
  await mkdir(directory, { recursive: true })
  const marker = path.join(tmp.path, "marker.txt")
  const source = path.join(directory, "hot.ts")
  await writeFile(source, lifecycleSource(marker, "test.hot", "v1"))

  await using app = await bootApp(tmp.path)
  const read = () => readFile(marker, "utf8")
  expect(await until(read, (value) => value === "v1:setup\n")).toBe("v1:setup\n")

  await writeFile(source, lifecycleSource(marker, "test.hot", "v2"))
  expect(await until(read, (value) => value?.includes("v2:setup") ?? false)).toBe("v1:setup\nv1:cleanup\nv2:setup\n")

  process.emit("SIGHUP")
  await app.task
})

test("does not activate a local plugin whose source changes during import", async () => {
  await using tmp = await tmpdir()
  const directory = path.join(tmp.path, ".opencode", "plugins", "tui")
  await mkdir(directory, { recursive: true })
  const marker = path.join(tmp.path, "marker.txt")
  const ready = path.join(tmp.path, "ready.txt")
  const gate = path.join(tmp.path, "gate.txt")
  const source = path.join(directory, "hot.ts")
  await writeFile(source, lifecycleSource(marker, "test.hot", "v1"))

  await using app = await bootApp(tmp.path)
  const read = () => readFile(marker, "utf8")
  expect(await until(read, (value) => value === "v1:setup\n")).toBe("v1:setup\n")

  await writeFile(source, gatedLifecycleSource(marker, ready, gate, "test.hot", "v2"))
  try {
    expect(
      await until(
        () => readFile(ready, "utf8"),
        (value) => value === "ready\n",
      ),
    ).toBe("ready\n")
    await writeFile(source, lifecycleSource(marker, "test.hot", "v3"))
    await writeFile(gate, "open")

    expect(await until(read, (value) => value?.includes("v3:setup") ?? false)).toBe("v1:setup\nv1:cleanup\nv3:setup\n")
  } finally {
    await writeFile(gate, "open")
  }

  process.emit("SIGHUP")
  await app.task
})

test("a plugin whose slot render throws does not take down the TUI", async () => {
  await using tmp = await tmpdir()
  const directory = path.join(tmp.path, ".opencode", "plugins", "tui")
  await mkdir(directory, { recursive: true })
  const markerA = path.join(tmp.path, "a.txt")
  const markerCrash = path.join(tmp.path, "crash.txt")
  const sourceA = path.join(directory, "a.ts")
  await writeFile(sourceA, lifecycleSource(markerA, "test.a", "a1"))
  await writeFile(
    path.join(directory, "crash.ts"),
    `
import { appendFile } from "node:fs/promises"
export default {
  id: "test.crash",
  setup: async (context: any) => {
    context.ui.slot({
      replace: "home.footer",
      render: () => {
        throw new Error("boom")
      },
    })
    await appendFile(${JSON.stringify(markerCrash)}, "setup\\n")
  },
}
`,
  )

  await using app = await bootApp(tmp.path)
  const readA = () => readFile(markerA, "utf8")
  expect(await until(readA, (value) => value === "a1:setup\n")).toBe("a1:setup\n")
  // The crashing plugin genuinely loaded and registered its slot; without
  // this the rest of the test would pass even if it never imported.
  expect(
    await until(
      () => readFile(markerCrash, "utf8"),
      (value) => value === "setup\n",
    ),
  ).toBe("setup\n")

  // The app survives the crashing slot: hot reload still works for others.
  // The render-time boundary itself (fallback + toast) is not exercisable
  // here: the test renderer never executes slot render bodies, so render
  // containment is verified in the real TUI (see PluginBoundary in
  // src/plugin/render.tsx and the demo runs on the PR).
  await writeFile(sourceA, lifecycleSource(markerA, "test.a", "a2"))
  expect(await until(readA, (value) => value?.includes("a2:setup") ?? false)).toBe("a1:setup\na1:cleanup\na2:setup\n")

  process.emit("SIGHUP")
  await app.task
})

test("editing one plugin leaves others untouched and a broken save keeps the last good version", async () => {
  await using tmp = await tmpdir()
  const directory = path.join(tmp.path, ".opencode", "plugins", "tui")
  await mkdir(directory, { recursive: true })
  const markerA = path.join(tmp.path, "a.txt")
  const markerB = path.join(tmp.path, "b.txt")
  const sourceA = path.join(directory, "a.ts")
  const sourceB = path.join(directory, "b.ts")
  await writeFile(sourceA, lifecycleSource(markerA, "test.a", "a1"))
  await writeFile(sourceB, lifecycleSource(markerB, "test.b", "b1"))

  await using app = await bootApp(tmp.path)
  const readA = () => readFile(markerA, "utf8")
  const readB = () => readFile(markerB, "utf8")
  await until(readA, (value) => value === "a1:setup\n")
  await until(readB, (value) => value === "b1:setup\n")

  // Editing B restarts only B: A sees no cleanup and no second setup.
  await writeFile(sourceB, lifecycleSource(markerB, "test.b", "b2"))
  expect(await until(readB, (value) => value?.includes("b2:setup") ?? false)).toBe("b1:setup\nb1:cleanup\nb2:setup\n")
  expect(await readA()).toBe("a1:setup\n")

  // A broken save keeps the last good version running: b2 is never cleaned
  // up. Editing A afterwards provides a positive completion signal — once
  // A's swap lands, the serialized reconcile has processed the broken save.
  await writeFile(sourceB, "export default {")
  await writeFile(sourceA, lifecycleSource(markerA, "test.a", "a2"))
  expect(await until(readA, (value) => value?.includes("a2:setup") ?? false)).toBe("a1:setup\na1:cleanup\na2:setup\n")
  expect(await readB()).toBe("b1:setup\nb1:cleanup\nb2:setup\n")

  // Fixing the file replaces the kept version and leaves A alone.
  await writeFile(sourceB, lifecycleSource(markerB, "test.b", "b3"))
  expect(await until(readB, (value) => value?.includes("b3:setup") ?? false)).toBe(
    "b1:setup\nb1:cleanup\nb2:setup\nb2:cleanup\nb3:setup\n",
  )
  expect(await readA()).toBe("a1:setup\na1:cleanup\na2:setup\n")

  process.emit("SIGHUP")
  await app.task
})

test("a save whose setup throws restores the previous version", async () => {
  await using tmp = await tmpdir()
  const directory = path.join(tmp.path, ".opencode", "plugins", "tui")
  await mkdir(directory, { recursive: true })
  const marker = path.join(tmp.path, "a.txt")
  const markerB = path.join(tmp.path, "b.txt")
  const source = path.join(directory, "a.ts")
  const sourceB = path.join(directory, "b.ts")
  await writeFile(source, lifecycleSource(marker, "test.a", "a1"))
  await writeFile(sourceB, lifecycleSource(markerB, "test.b", "b1"))

  await using app = await bootApp(tmp.path)
  const read = () => readFile(marker, "utf8")
  const readB = () => readFile(markerB, "utf8")
  expect(await until(read, (value) => value === "a1:setup\n")).toBe("a1:setup\n")
  expect(await until(readB, (value) => value === "b1:setup\n")).toBe("b1:setup\n")

  // The module imports fine but its setup throws — unlike an import failure,
  // the swap has already torn down a1, so keep-last-good means restoring it.
  const broken = `
export default {
  id: "test.a",
  setup: async () => {
    throw new Error("setup boom")
  },
}
`
  await writeFile(source, broken)
  expect(await until(read, (value) => value === "a1:setup\na1:cleanup\na1:setup\n")).toBe(
    "a1:setup\na1:cleanup\na1:setup\n",
  )

  // Duplicate notifications for unchanged contents must not retry the broken
  // generation and cycle the restored plugin again.
  await writeFile(source, broken)
  await writeFile(sourceB, lifecycleSource(markerB, "test.b", "b2"))
  expect(await until(readB, (value) => value?.includes("b2:setup") ?? false)).toBe("b1:setup\nb1:cleanup\nb2:setup\n")
  expect(await read()).toBe("a1:setup\na1:cleanup\na1:setup\n")

  // Fixing the file swaps out the restored version normally.
  await writeFile(source, lifecycleSource(marker, "test.a", "a2"))
  expect(await until(read, (value) => value?.includes("a2:setup") ?? false)).toBe(
    "a1:setup\na1:cleanup\na1:setup\na1:cleanup\na2:setup\n",
  )

  process.emit("SIGHUP")
  await app.task
})

test("editing a symlinked plugin's target hot-reloads it", async () => {
  await using tmp = await tmpdir()
  const directory = path.join(tmp.path, ".opencode", "plugins", "tui")
  await mkdir(directory, { recursive: true })
  const marker = path.join(tmp.path, "a.txt")
  // The real source lives outside the discovery directory; only a symlink
  // is discovered. Edits land at the target, which emits no event in the
  // plugin directory itself.
  const target = path.join(tmp.path, "elsewhere", "a.ts")
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, lifecycleSource(marker, "test.a", "a1"))
  await symlink(target, path.join(directory, "a.ts"))

  await using app = await bootApp(tmp.path)
  const read = () => readFile(marker, "utf8")
  expect(await until(read, (value) => value === "a1:setup\n")).toBe("a1:setup\n")

  await writeFile(target, lifecycleSource(marker, "test.a", "a2"))
  expect(await until(read, (value) => value?.includes("a2:setup") ?? false)).toBe("a1:setup\na1:cleanup\na2:setup\n")

  process.emit("SIGHUP")
  await app.task
})

test("memory storage survives hot reload while disk storage persists", async () => {
  await using tmp = await tmpdir()
  const directory = path.join(tmp.path, ".opencode", "plugins", "tui")
  await mkdir(directory, { recursive: true })
  const marker = path.join(tmp.path, "counter.txt")
  const source = path.join(directory, "counter.ts")
  const counterSource = (note: string) => `
import { appendFile } from "node:fs/promises"
// ${note}
export default {
  id: "test.counter",
  setup: async (context: any) => {
    const [state, update] = context.storage.memory("counter", { initial: { count: 0 } })
    update((draft: any) => {
      draft.count += 1
    })
    await appendFile(${JSON.stringify(marker)}, "count:" + state.count + "\\n")
  },
}
`
  await writeFile(source, counterSource("v1"))

  await using app = await bootApp(tmp.path)
  const read = () => readFile(marker, "utf8")
  expect(await until(read, (value) => value === "count:1\n")).toBe("count:1\n")

  // The reloaded generation shares the same live store: the count continues.
  await writeFile(source, counterSource("v2"))
  expect(await until(read, (value) => value?.includes("count:2") ?? false)).toBe("count:1\ncount:2\n")

  process.emit("SIGHUP")
  await app.task
})
