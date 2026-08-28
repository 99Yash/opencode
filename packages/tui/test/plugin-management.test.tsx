import { expect, test } from "bun:test"
import type { PluginInfo } from "@opencode-ai/client"
import { InputRenderable, type Renderable } from "@opentui/core"
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing"
import { Effect, FileSystem } from "effect"
import { Global } from "@opencode-ai/util/global"
import path from "node:path"
import type { Info } from "../src/config"
import type { PackageResolver } from "../src/plugin/context"
import { tmpdir } from "./fixture/fixture"
import { createEventStream, createFetch, json, type FetchHandler } from "./fixture/tui-client"
import { noPackages } from "./fixture/tui-packages"

const target = "fixture-plugin@latest"
const packageEntry = (revision: "1.0.0" | "2.0.0" | "broken") => ({
  entrypoint: new URL(
    `./fixture/plugin-management/package-${revision === "1.0.0" ? "v1" : revision === "2.0.0" ? "v2" : "broken"}.ts`,
    import.meta.url,
  ).href,
  revision: revision === "broken" ? "2.0.0" : revision,
  generation: revision,
})

async function bootApp(
  directory: string,
  options: {
    width?: number
    height?: number
    plugins?: Info["plugins"]
    server?: () => PluginInfo[]
    packages?: PackageResolver
    fetch?: FetchHandler
  } = {},
) {
  const setup = await createTestRenderer({
    width: options.width ?? 100,
    height: options.height ?? 40,
    useThread: false,
    kittyKeyboard: true,
  })
  setup.renderer.start()
  const location = { directory, project: { id: "proj_fixture", directory, canonical: directory } }
  const events = createEventStream()
  const requests: Array<{ path: string; method: string; directory: string | null; body: unknown }> = []
  const calls = createFetch(async (url, request) => {
    if (/^\/api\/plugin\/(check|update|reload)$/.test(url.pathname))
      requests.push({
        path: url.pathname,
        method: request.method,
        directory: url.searchParams.get("location[directory]"),
        body: await request.clone().json(),
      })
    const override = await options.fetch?.(url, request)
    if (override) return override
    if (url.pathname === "/api/plugin") return json({ location, data: options.server?.() ?? [] })
    if (url.pathname === "/api/location") return json(location)
    if (url.pathname === "/api/fs/list") return json({ location, data: [] })
  }, events)
  const server = Bun.serve({ port: 0, fetch: (request) => calls.fetch(request) })
  const cwd = process.cwd()
  process.chdir(directory)
  const { run } = await import("../src/app")
  const task = Effect.runPromise(
    run({
      app: { name: "test", version: "test", channel: "test" },
      server: { endpoint: { url: server.url.toString() } },
      config: {
        get: async () => ({ animations: false, plugins: options.plugins ?? [], keybinds: { "plugins.list": "f6" } }),
        update: async () => ({}),
      },
      packages: options.packages ?? noPackages,
      terminalHandoff: async () => ({ renderer: setup.renderer, mode: "dark", complete: () => {} }),
      args: {},
      log: () => {},
    }).pipe(
      Effect.provide(
        Global.layerWith({
          home: directory,
          config: path.join(directory, "config"),
          data: path.join(directory, "data"),
          cache: path.join(directory, "cache"),
          state: path.join(directory, "state"),
          tmp: path.join(directory, "tmp"),
          bin: path.join(directory, "bin"),
          log: path.join(directory, "log"),
          repos: path.join(directory, "repos"),
        }),
      ),
      Effect.provide(FileSystem.layerNoop({})),
    ),
  )
  return {
    ...setup,
    requests,
    async [Symbol.asyncDispose]() {
      if (!setup.renderer.isDestroyed) setup.renderer.destroy()
      await task.finally(async () => {
        process.chdir(cwd)
        events.disconnect()
        await server.stop(true)
      })
    },
  }
}

async function openPlugins(app: TestRendererSetup, search: string) {
  await app.waitForFrame((frame) => frame.includes("Ask anything"), { maxPasses: 100 })
  app.mockInput.pressKey("F6")
  await app.waitForFrame((frame) => frame.includes("Plugins") && frame.includes("Search"))
  await app.waitFor(() => app.renderer.currentFocusedRenderable instanceof InputRenderable)
  await app.mockInput.typeText(search)
  await app.waitForFrame((frame) => frame.includes(search) && !frame.includes("Search"))
}

async function click(app: TestRendererSetup, text: string) {
  const frame = await app.waitForFrame((frame) => frame.includes(text))
  const lines = frame.split("\n")
  const y = lines.findIndex((line) => line.includes(text))
  await app.mockMouse.click(lines[y].indexOf(text) + 1, y)
}

async function scrollMetadata(app: TestRendererSetup, expected: string, direction: "up" | "down" = "down") {
  const lines = app.captureCharFrame().split("\n")
  const y = lines.findIndex((line) =>
    /^\s*(Runtime|Scope|Status|Source|Loaded|Installed|Available|Provides)\s{2,}/.test(line),
  )
  if (y < 0) throw new Error("Plugin metadata viewport was not found")
  const x = lines[y].search(/\S/) + 1
  for (let attempt = 0; attempt < 8; attempt++) {
    if (app.captureCharFrame().replace(/\s+/g, " ").includes(expected)) return app.captureCharFrame()
    await app.mockMouse.scroll(x, y, direction)
    await app.renderOnce()
  }
  return app.captureCharFrame()
}

function findFilter(root: Renderable): InputRenderable | undefined {
  if (root instanceof InputRenderable && root.traits.status === "FILTER") return root
  return root.getChildren().map(findFilter).find(Boolean)
}

test("package checks are explicit and a busy update preserves the dialog and selected action", async () => {
  await using tmp = await tmpdir()
  const checked: string[] = []
  const updates: string[] = []
  const release = Promise.withResolvers<void>()
  await using app = await bootApp(tmp.path, {
    plugins: [target],
    packages: {
      ...noPackages,
      resolve: async () => packageEntry("1.0.0"),
      check: async (spec) => {
        checked.push(spec)
        return { installed: "1.5.0", available: "2.0.0", mutable: true }
      },
      update: async (spec) => {
        updates.push(spec)
        await release.promise
        return packageEntry("2.0.0")
      },
    },
  })
  try {
    await openPlugins(app, "fixture.package")
    expect(checked).toEqual([])
    const filter = findFilter(app.renderer.root)
    expect(filter).toBeDefined()
    if (!filter) throw new Error("Plugin list filter was not found")
    app.mockInput.pressKey("r", { ctrl: true })
    const available = await app.waitForFrame((frame) => frame.includes("\u2191 update"))
    expect(available).toContain("fixture.package")
    expect(checked).toEqual([target])
    expect(findFilter(app.renderer.root)).toBe(filter)
    expect(app.renderer.currentFocusedRenderable).toBe(filter)
    expect(filter.value).toBe("fixture.package")

    app.mockInput.pressEnter()
    const details = await app.waitForFrame((frame) => frame.includes("Check for updates"))
    expect(details).toContain("Loaded     1.0.0")
    expect(details).toContain("Installed  1.5.0")
    expect(details).toContain("Available  2.0.0")
    app.mockInput.pressArrow("down")
    app.mockInput.pressEnter()
    await app.waitForFrame((frame) => frame.includes("Updating; waiting"))
    app.mockInput.pressEnter()
    await click(app, "Update package")
    expect(updates).toEqual([target])
    release.resolve()
    const updated = await app.waitForFrame(
      (frame) => frame.includes("Loaded     2.0.0") && frame.includes("No newer revision"),
    )
    expect(updated).toContain("Installed  2.0.0")
    expect(updated).not.toContain("\u2191 available")
    expect(updated).not.toContain("Updating; waiting")

    // Enter repeats the selected update, rather than resetting to the check row.
    app.mockInput.pressEnter()
    await app.waitFor(() => updates.length === 2)
    await app.waitForFrame((frame) => !frame.includes("Updating; waiting"))
    expect(checked).toEqual([target])
    app.mockInput.pressEscape()
    await app.waitForFrame((frame) => frame.includes("Plugins") && frame.includes("Search"))
    await app.waitFor(() => app.renderer.currentFocusedRenderable instanceof InputRenderable)
    await app.mockInput.typeText("fixture.package")
    const list = await app.waitForFrame((frame) => frame.includes("fixture.package") && frame.includes("enter details"))
    expect(list).not.toContain("\u2191 update")
    expect(app.requests).toEqual([])
  } finally {
    release.resolve()
  }
})

test.each([100, 40])("server package controls remain visible and usable at %i columns and 24 rows", async (width) => {
  await using tmp = await tmpdir()
  const inventory: PluginInfo[] = [
    {
      id: "fixture.server",
      source: { type: "package", package: target },
      status: "active",
      tui: false,
      revision: "1.0.0",
      generation: "first",
    },
  ]
  await using app = await bootApp(tmp.path, {
    width,
    height: 24,
    server: () => inventory,
    fetch: (url) => {
      const location = { directory: tmp.path, project: { id: "proj_fixture", directory: tmp.path } }
      if (url.pathname === "/api/plugin/check")
        return json({ location, data: { installed: "1.5.0", available: "2.0.0", mutable: true } })
      if (url.pathname === "/api/plugin/update") {
        inventory[0] = { ...inventory[0], revision: "2.0.0", generation: "second" }
        return json({ location, data: inventory })
      }
    },
  })
  await openPlugins(app, "fixture.server")
  expect(app.requests).toEqual([])
  app.mockInput.pressKey("r", { ctrl: true })
  await app.waitForFrame((frame) => frame.includes("\u2191 update"))
  app.mockInput.pressEnter()
  const details = await app.waitForFrame((frame) => frame.includes("Check for updates"))
  expect(details).toContain("Reload installed code")
  expect(details).toContain("Back to plugins")
  expect(details).toContain("A newer revision is available.")
  expect(details).not.toContain("Disable in this terminal")
  const metadata = await scrollMetadata(app, "Available 2.0.0")
  expect(metadata).toContain("Loaded     1.0.0")
  expect(metadata).toContain("Installed  1.5.0")
  expect(metadata).toContain("Available  2.0.0")
  const source = await scrollMetadata(app, "Provides fixture.server")
  expect(source.replace(/\s+/g, " ")).toContain("Provides fixture.server")
  expect(source).toContain("Scope      ~")
  await click(app, "Update package")
  await app.waitForFrame((frame) => frame.includes("No newer revision at last check."))
  const updated = await scrollMetadata(app, "Loaded 2.0.0", "up")
  expect(updated).toContain("Loaded     2.0.0")
  expect(updated).not.toContain("\u2191 available")
  expect(updated).toContain("No newer revision at last check.")
  expect(app.requests).toEqual([
    { path: "/api/plugin/check", method: "POST", directory: tmp.path, body: { target } },
    { path: "/api/plugin/update", method: "POST", directory: tmp.path, body: { target } },
  ])
})

test("companion rows share one server-owned check and update the advertised terminal revision", async () => {
  await using tmp = await tmpdir()
  const inventory: PluginInfo[] = ["fixture.server", "fixture.second"].map((id) => ({
    id,
    source: { type: "package", package: target },
    status: "active",
    tui: true,
    revision: "1.0.0",
    generation: "first",
  }))
  const resolutions: Array<{ spec: string; install?: boolean; revision?: string }> = []
  const localActions: string[] = []
  const release = Promise.withResolvers<void>()
  await using app = await bootApp(tmp.path, {
    // The same raw source can also be configured in cli.json.
    plugins: [target],
    server: () => inventory,
    packages: {
      resolve: async (spec, install, revision) => {
        resolutions.push({ spec, install, revision })
        return packageEntry(revision === "2.0.0" ? "2.0.0" : "1.0.0")
      },
      check: async (spec) => {
        localActions.push(`check:${spec}`)
        return { mutable: true }
      },
      update: async (spec) => {
        localActions.push(`update:${spec}`)
        return packageEntry("2.0.0")
      },
      reload: async (spec) => {
        localActions.push(`reload:${spec}`)
        return packageEntry("2.0.0")
      },
    },
    fetch: async (url) => {
      const location = { directory: tmp.path, project: { id: "proj_fixture", directory: tmp.path } }
      if (url.pathname === "/api/plugin/check")
        return json({ location, data: { installed: "1.0.0", available: "2.0.0", mutable: true } })
      if (url.pathname === "/api/plugin/update") {
        await release.promise
        inventory.splice(
          0,
          inventory.length,
          ...inventory.map((plugin) => ({ ...plugin, revision: "2.0.0", generation: "second" })),
        )
        return json({ location, data: inventory })
      }
    },
  })
  try {
    await openPlugins(app, "fixture.")
    await app.waitForFrame(
      (frame) =>
        frame.includes("fixture.package") && frame.includes("fixture.server") && frame.includes("fixture.second"),
    )
    expect(app.requests).toEqual([])
    app.mockInput.pressEnter()
    await click(app, "Check for updates")
    await app.waitForFrame((frame) => frame.includes("A newer revision is available."))
    app.mockInput.pressEscape()
    await app.waitForFrame((frame) => frame.includes("Plugins") && frame.includes("Search"))
    await app.waitFor(() => app.renderer.currentFocusedRenderable instanceof InputRenderable)
    await app.mockInput.typeText("fixture.")
    const list = await app.waitForFrame((frame) => frame.split("\u2191 update").length === 4)
    expect(list.split("\n").filter((line) => line.includes("fixture.package"))).toHaveLength(1)
    expect(app.requests).toEqual([{ path: "/api/plugin/check", method: "POST", directory: tmp.path, body: { target } }])
    expect(localActions).toEqual([])

    app.mockInput.pressEnter()
    await click(app, "Update package")
    await app.waitForFrame((frame) => frame.includes("Updating; waiting"))
    app.mockInput.pressEnter()
    await click(app, "Update package")
    expect(app.requests.filter((request) => request.path === "/api/plugin/update")).toHaveLength(1)
    release.resolve()
    await app.waitForFrame((frame) => frame.includes("Loaded     2.0.0") && frame.includes("No newer revision"))
    expect(resolutions).toContainEqual({ spec: target, install: true, revision: "2.0.0" })
    expect(localActions).toEqual([])
    app.mockInput.pressEscape()
    await app.waitForFrame((frame) => frame.includes("Plugins"))
    app.mockInput.pressEscape()
    await openPlugins(app, "fixture.")
    const reopened = await app.waitForFrame(
      (frame) => frame.includes("fixture.server") && frame.includes("fixture.package"),
    )
    expect(reopened).not.toContain("\u2191 update")
    expect(app.requests).toHaveLength(2)
  } finally {
    release.resolve()
  }
})

test("a failed terminal package update retains its loaded revision and exposes the real setup error", async () => {
  await using tmp = await tmpdir()
  await using app = await bootApp(tmp.path, {
    plugins: [target],
    packages: {
      ...noPackages,
      resolve: async () => packageEntry("1.0.0"),
      check: async () => ({ installed: "2.0.0", available: "2.0.0", mutable: true }),
      update: async () => packageEntry("broken"),
    },
  })
  await openPlugins(app, "fixture.package")
  app.mockInput.pressKey("r", { ctrl: true })
  // A newer cached install is not evidence that this terminal activated it.
  await app.waitForFrame((frame) => frame.includes("\u2191 update"))
  app.mockInput.pressEnter()
  await click(app, "Update package")
  const failed = await app.waitForFrame(
    (frame) => frame.includes("View error details") && frame.includes("Operation failed"),
  )
  expect(failed).toContain("Loaded     1.0.0")
  expect(failed).toContain("Installed  2.0.0")
  expect(failed).toContain("Status     active")
  expect(failed).toContain("\u2191 available")
  await click(app, "View error details")
  await app.waitForFrame(
    (frame) => frame.includes("Fixture replacement failed during setup") && frame.includes("copy details"),
  )
  app.mockInput.pressEscape()
  await app.waitForFrame((frame) => frame.includes("Loaded     1.0.0") && frame.includes("View error details"))
  expect(app.requests).toEqual([])
})

test("a failed server replacement reports the previous active revision and details", async () => {
  await using tmp = await tmpdir()
  const inventory: PluginInfo[] = [
    {
      id: "fixture.server",
      source: { type: "package", package: target },
      status: "active",
      tui: false,
      revision: "1.0.0",
      generation: "first",
    },
  ]
  await using app = await bootApp(tmp.path, {
    server: () => inventory,
    fetch: (url) => {
      if (url.pathname !== "/api/plugin/update") return
      inventory[0] = { ...inventory[0], error: "Server replacement failed during setup" }
      return json({
        location: { directory: tmp.path, project: { id: "proj_fixture", directory: tmp.path } },
        data: inventory,
      })
    },
  })
  await openPlugins(app, "fixture.server")
  app.mockInput.pressEnter()
  await click(app, "Update package")
  const failed = await app.waitForFrame(
    (frame) => frame.includes("View error details") && frame.includes("Operation failed"),
  )
  expect(failed).toContain("Loaded     1.0.0")
  expect(failed).toContain("Status     active")
  await click(app, "View error details")
  await app.waitForFrame(
    (frame) => frame.includes("Server replacement failed during setup") && frame.includes("copy details"),
  )
  app.mockInput.pressEscape()
  await app.waitForFrame((frame) => frame.includes("View error details"))
  app.mockInput.pressEscape()
  await app.waitForFrame((frame) => frame.includes("Plugins") && frame.includes("Search"))
  await app.waitFor(() => app.renderer.currentFocusedRenderable instanceof InputRenderable)
  await app.mockInput.typeText("fixture.server")
  await app.waitForFrame((frame) => frame.includes("previous active"))
  expect(app.requests).toEqual([{ path: "/api/plugin/update", method: "POST", directory: tmp.path, body: { target } }])
})

test.each(["tui", "server"] as const)(
  "an exact %s reload preserves newer installed and available metadata",
  async (runtime) => {
    await using tmp = await tmpdir()
    const location = { directory: tmp.path, project: { id: "proj_fixture", directory: tmp.path } }
    const inventory: PluginInfo[] = [
      {
        id: "fixture.server",
        source: { type: "package", package: target },
        status: "active",
        tui: false,
        revision: "1.0.0",
        generation: "first",
      },
    ]
    const reloads: Array<{ target: string; options: Parameters<PackageResolver["reload"]>[1] }> = []
    await using app = await bootApp(tmp.path, {
      plugins: runtime === "tui" ? [target] : [],
      server: () => (runtime === "server" ? inventory : []),
      packages: {
        ...noPackages,
        resolve: async () => packageEntry("1.0.0"),
        check: async () => ({ installed: "2.0.0", available: "2.0.0", mutable: true }),
        reload: async (target, options) => {
          reloads.push({ target, options })
          return { ...packageEntry("1.0.0"), generation: "reloaded" }
        },
      },
      fetch: (url) => {
        if (url.pathname === "/api/plugin/check")
          return json({ location, data: { installed: "2.0.0", available: "2.0.0", mutable: true } })
        if (url.pathname === "/api/plugin/reload") {
          inventory[0] = { ...inventory[0], generation: "reloaded" }
          return json({ location, data: inventory })
        }
      },
    })
    const label = runtime === "tui" ? "fixture.package" : "fixture.server"
    await openPlugins(app, label)
    app.mockInput.pressKey("r", { ctrl: true })
    await app.waitForFrame((frame) => frame.includes("\u2191 update"))
    app.mockInput.pressEnter()
    const checked = await app.waitForFrame((frame) => frame.includes("Reload installed code"))
    expect(checked).toContain("Loaded     1.0.0")
    expect(checked).toContain("Installed  2.0.0")
    expect(checked).toContain("Available  2.0.0")
    await click(app, "Reload installed code")
    const reloaded = await app.waitForFrame(
      (frame) => frame.includes("Plugin reloaded") && !frame.includes("Reloading; waiting"),
    )
    expect(reloaded).toContain("Loaded     1.0.0")
    expect(reloaded).toContain("Installed  2.0.0")
    expect(reloaded).toContain("Available  2.0.0")
    expect(reloaded).toContain("\u2191 available")
    expect(reloaded).not.toContain("No newer revision")
    expect(reloads).toEqual(runtime === "tui" ? [{ target, options: { revision: "1.0.0", generation: "1.0.0" } }] : [])
    expect(app.requests).toEqual(
      runtime === "server"
        ? [
            { path: "/api/plugin/check", method: "POST", directory: tmp.path, body: { target } },
            { path: "/api/plugin/reload", method: "POST", directory: tmp.path, body: { target } },
          ]
        : [],
    )
    app.mockInput.pressEscape()
    await app.waitForFrame((frame) => frame.includes("Plugins") && frame.includes("Search"))
    await app.waitFor(() => app.renderer.currentFocusedRenderable instanceof InputRenderable)
    await app.mockInput.typeText(label)
    await app.waitForFrame((frame) => frame.includes(label) && frame.includes("\u2191 update"))
  },
)

test("a pinned package can be checked and reloaded but does not offer update", async () => {
  await using tmp = await tmpdir()
  const pinned = "fixture-plugin@1.0.0"
  const actions: string[] = []
  await using app = await bootApp(tmp.path, {
    plugins: [pinned],
    packages: {
      ...noPackages,
      resolve: async () => packageEntry("1.0.0"),
      check: async (spec) => {
        actions.push(`check:${spec}`)
        return { installed: "1.0.0", available: "2.0.0", mutable: false }
      },
      reload: async (spec) => {
        actions.push(`reload:${spec}`)
        return packageEntry("1.0.0")
      },
    },
  })
  await openPlugins(app, "fixture.package")
  expect(actions).toEqual([])
  app.mockInput.pressEnter()
  await click(app, "Check for updates")
  const checked = await app.waitForFrame((frame) => frame.includes("(pinned)"))
  expect(checked).not.toContain("Update package")
  expect(checked).not.toContain("\u2191 available")
  expect(checked).toContain("Reload installed code")
  app.mockInput.pressArrow("down")
  app.mockInput.pressEnter()
  await app.waitFor(() => actions.length === 2)
  await app.waitForFrame((frame) => !frame.includes("Reloading; waiting"))
  expect(actions).toEqual([`check:${pinned}`, `reload:${pinned}`])
  app.mockInput.pressEscape()
  await app.waitForFrame((frame) => frame.includes("Plugins"))
  app.mockInput.pressEscape()
  await openPlugins(app, "fixture.package")
  expect(app.captureCharFrame()).not.toContain("\u2191 update")
  app.mockInput.pressEnter()
  const reopened = await app.waitForFrame((frame) => frame.includes("(pinned)"))
  expect(reopened).not.toContain("Update package")
  expect(actions).toHaveLength(2)
  expect(app.requests).toEqual([])
})

test("builtin details retain enable and disable without package or reload actions", async () => {
  await using tmp = await tmpdir()
  await using app = await bootApp(tmp.path, { width: 40, height: 24 })
  await openPlugins(app, "opencode.notifications")
  app.mockInput.pressEnter()
  await app.waitForFrame((frame) => frame.includes("Disable in this terminal"))
  const details = await scrollMetadata(app, "Updates with OpenCode itself.")
  expect(details.replace(/\s+/g, " ")).toContain("Updates with OpenCode itself.")
  expect(details).not.toContain("Check for updates")
  expect(details).not.toContain("Update package")
  expect(details).not.toContain("Reload installed code")
  app.mockInput.pressEnter()
  await app.waitForFrame((frame) => frame.includes("Status     inactive") && frame.includes("Enable in this terminal"))
  app.mockInput.pressEnter()
  await app.waitForFrame((frame) => frame.includes("Status     active") && frame.includes("Disable in this terminal"))
  expect(app.requests).toEqual([])
})

test("local terminal details reload the source and retain toggle controls without package calls", async () => {
  await using tmp = await tmpdir()
  const marker = path.join(tmp.path, "lifecycle.txt")
  const local = new URL("./fixture/plugin-management/local.ts", import.meta.url).href
  await using app = await bootApp(tmp.path, {
    plugins: [{ package: local, options: { marker } }],
  })
  await openPlugins(app, "fixture.local")
  expect(await Bun.file(marker).text()).toBe("setup\n")
  app.mockInput.pressKey(" ")
  await app.waitForFrame((frame) => frame.includes("inactive") && frame.includes("enable space"))
  app.mockInput.pressKey(" ")
  await app.waitForFrame((frame) => !frame.includes("inactive") && frame.includes("disable space"))
  app.mockInput.pressEnter()
  const details = await app.waitForFrame((frame) => frame.includes("Reload installed code"))
  expect(details).not.toContain("Check for updates")
  expect(details).not.toContain("Update package")
  expect(details).toContain("Disable in this terminal")
  await click(app, "Reload installed code")
  await app.waitFor(async () => (await Bun.file(marker).text()) === "setup\ncleanup\nsetup\ncleanup\nsetup\n")
  await app.waitForFrame((frame) => !frame.includes("Reloading; waiting"))
  expect(app.requests).toEqual([])
})

test.each(["local", "builtin", "sdk"] as const)(
  "Enter opens %s server details with only source-appropriate actions",
  async (source) => {
    await using tmp = await tmpdir()
    const local = path.join(tmp.path, "server.ts")
    const inventory: PluginInfo[] = [
      {
        id: "fixture.server",
        source: source === "local" ? { type: "local", path: local } : { type: source },
        status: "active",
        tui: false,
      },
    ]
    await using app = await bootApp(tmp.path, {
      server: () => inventory,
      fetch: (url) => {
        if (url.pathname === "/api/plugin/reload")
          return json({
            location: { directory: tmp.path, project: { id: "proj_fixture", directory: tmp.path } },
            data: inventory,
          })
      },
    })
    await openPlugins(app, "fixture.server")
    app.mockInput.pressEnter()
    const details = await app.waitForFrame(
      (frame) => frame.includes("Runtime    Server") && frame.includes("Back to plugins"),
    )
    expect(details).not.toContain("Check for updates")
    expect(details).not.toContain("Update package")
    expect(details).not.toContain("Disable in this terminal")
    if (source !== "local") {
      expect(details).not.toContain("Reload installed code")
      expect(app.requests).toEqual([])
      return
    }
    await click(app, "Reload installed code")
    await app.waitFor(() => app.requests.length === 1)
    await app.waitForFrame((frame) => !frame.includes("Reloading; waiting"))
    expect(app.requests).toEqual([
      { path: "/api/plugin/reload", method: "POST", directory: tmp.path, body: { target: local } },
    ])
  },
)

test("Escape returns to the same busy dialog while a server update waits", async () => {
  await using tmp = await tmpdir()
  const release = Promise.withResolvers<void>()
  const inventory: PluginInfo[] = [
    {
      id: "fixture.server",
      source: { type: "package", package: target },
      status: "active",
      tui: false,
      revision: "1.0.0",
    },
  ]
  await using app = await bootApp(tmp.path, {
    width: 40,
    height: 24,
    server: () => inventory,
    fetch: async (url) => {
      if (url.pathname !== "/api/plugin/update") return
      await release.promise
      inventory[0] = { ...inventory[0], revision: "2.0.0" }
      return json({
        location: { directory: tmp.path, project: { id: "proj_fixture", directory: tmp.path } },
        data: inventory,
      })
    },
  })
  try {
    await openPlugins(app, "fixture.server")
    app.mockInput.pressEnter()
    await click(app, "Update package")
    const busy = await app.waitForFrame((frame) => frame.includes("Updating; waiting"))
    expect(busy.replace(/\s+/g, " ")).toContain("Updating; waiting for running work...")
    app.mockInput.pressEscape()
    await app.waitForFrame((frame) => frame.includes("Plugins") && frame.includes("Updating; waiting"))
    const filter = findFilter(app.renderer.root)
    expect(filter).toBeDefined()
    app.mockInput.pressKey("r", { ctrl: true })
    app.mockInput.pressEnter()
    expect(app.requests).toHaveLength(1)
    release.resolve()
    await app.waitForFrame((frame) => frame.includes("Plugins") && !frame.includes("Updating; waiting"))
    expect(findFilter(app.renderer.root)).toBe(filter)
    expect(app.requests).toEqual([
      { path: "/api/plugin/update", method: "POST", directory: tmp.path, body: { target } },
    ])
  } finally {
    release.resolve()
  }
})

test("a server row arriving after filtering supplies the selected row's check action", async () => {
  await using tmp = await tmpdir()
  const release = Promise.withResolvers<void>()
  const state = { defer: false }
  const location = { directory: tmp.path, project: { id: "proj_fixture", directory: tmp.path } }
  await using app = await bootApp(tmp.path, {
    width: 40,
    height: 24,
    fetch: async (url) => {
      if (url.pathname === "/api/plugin") {
        if (!state.defer) return json({ location, data: [] })
        await release.promise
        return json({
          location,
          data: [
            {
              id: "fixture.server",
              source: { type: "package", package: target },
              status: "active",
              tui: false,
              revision: "1.0.0",
            },
          ],
        })
      }
      if (url.pathname === "/api/plugin/check")
        return json({ location, data: { installed: "1.0.0", available: "2.0.0", mutable: true } })
    },
  })
  try {
    await app.waitForFrame((frame) => frame.includes("Ask anything"), { maxPasses: 100 })
    state.defer = true
    await openPlugins(app, "fixture.server")
    await app.waitForFrame((frame) => frame.includes("No results found"))
    release.resolve()
    const ready = await app.waitForFrame(
      (frame) => frame.includes("check ctrl+r") && !frame.includes("No results found"),
    )
    expect(ready).not.toContain("disable space")
    expect(app.requests).toEqual([])
    app.mockInput.pressKey("r", { ctrl: true })
    await app.waitForFrame((frame) => frame.includes("\u2191 update"))
    expect(app.requests).toEqual([{ path: "/api/plugin/check", method: "POST", directory: tmp.path, body: { target } }])
  } finally {
    release.resolve()
  }
})
