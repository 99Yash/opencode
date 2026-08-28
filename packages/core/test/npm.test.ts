import fs from "fs/promises"
import path from "path"
import { pathToFileURL } from "url"
import { describe, expect, test } from "bun:test"
import { Cause, Effect, Exit, Fiber, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Global } from "@opencode-ai/util/global"
import { Npm } from "@opencode-ai/util/npm"
import { tmpdir, withTempDir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const win = process.platform === "win32"

const writePackage = (dir: string, pkg: Record<string, unknown>) =>
  Bun.write(
    path.join(dir, "package.json"),
    JSON.stringify({
      version: "1.0.0",
      ...pkg,
    }),
  )

const npmLayer = (cache: string) =>
  AppNodeBuilder.build(Npm.node, [[Global.node, Global.layerWith({ cache, state: path.join(cache, "state") })]])

async function createGitFixture(directory: string) {
  const repository = path.join(directory, "repository")
  await fs.mkdir(path.join(repository, "dependency"), { recursive: true })
  await writePackage(repository, {
    name: "fixture-git-plugin",
    type: "module",
    exports: { ".": "./index.js", "./cjs": "./index.cjs" },
    dependencies: { "fixture-dependency": "file:./dependency" },
  })
  await writePackage(path.join(repository, "dependency"), {
    name: "fixture-dependency",
    type: "module",
    exports: { import: "./index.js", require: "./index.cjs" },
  })
  await Bun.write(
    path.join(repository, "index.js"),
    'import { dependency } from "fixture-dependency"\nimport { relative } from "./relative.js"\nexport default { root: true }\nexport { dependency, relative }\n',
  )
  await Bun.write(path.join(repository, "relative.js"), 'export const relative = { value: "first" }\n')
  await Bun.write(path.join(repository, "dependency", "index.js"), 'export const dependency = { value: "first" }\n')
  await Bun.write(
    path.join(repository, "index.cjs"),
    'module.exports = { relative: require("./relative.cjs"), dependency: require("fixture-dependency") }\n',
  )
  await Bun.write(path.join(repository, "relative.cjs"), 'module.exports = { value: "first" }\n')
  await Bun.write(path.join(repository, "dependency", "index.cjs"), 'module.exports = { value: "first" }\n')

  const subdirectory = path.join(repository, "packages", "subdirectory-plugin")
  await fs.mkdir(path.join(subdirectory, "dependency"), { recursive: true })
  await writePackage(subdirectory, {
    name: "fixture-subdirectory-plugin",
    exports: "./index.js",
    dependencies: { "fixture-subdirectory-dependency": "file:./dependency" },
  })
  await writePackage(path.join(subdirectory, "dependency"), {
    name: "fixture-subdirectory-dependency",
    exports: "./index.js",
  })
  await Bun.write(path.join(subdirectory, "index.js"), "export default { subdirectory: true }\n")
  await Bun.write(path.join(subdirectory, "dependency", "index.js"), "export const dependency = true\n")

  await Bun.$`git init -q -b fixture-branch ${repository}`
  await Bun.$`git -C ${repository} add .`
  await Bun.$`git -C ${repository} -c user.name=fixture -c user.email=fixture@example.com commit -qm fixture`
  const commit = await Bun.$`git -C ${repository} rev-parse HEAD`.text().then((value) => value.trim())
  return { repository, commit }
}

async function advanceGitFixture(repository: string, value: string) {
  await Bun.write(path.join(repository, "relative.js"), `export const relative = { value: ${JSON.stringify(value)} }\n`)
  await Bun.write(
    path.join(repository, "dependency", "index.js"),
    `export const dependency = { value: ${JSON.stringify(value)} }\n`,
  )
  await Bun.write(path.join(repository, "relative.cjs"), `module.exports = { value: ${JSON.stringify(value)} }\n`)
  await Bun.write(
    path.join(repository, "dependency", "index.cjs"),
    `module.exports = { value: ${JSON.stringify(value)} }\n`,
  )
  await Bun.$`git -C ${repository} add .`
  await Bun.$`git -C ${repository} -c user.name=fixture -c user.email=fixture@example.com commit -qm ${value}`
  return Bun.$`git -C ${repository} rev-parse HEAD`.text().then((value) => value.trim())
}

async function createRegistryFixture(directory: string) {
  const tarballs = new Map<string, Uint8Array>()
  for (const version of ["1.0.0", "1.1.0", "1.2.0"]) {
    const root = path.join(directory, version)
    const pkg = path.join(root, "package")
    await fs.mkdir(pkg, { recursive: true })
    await writePackage(pkg, {
      name: "@fixture/registry-plugin",
      version,
      type: "module",
      exports: { ".": "./index.js", "./tui": "./index.js" },
      dependencies: { "@fixture/registry-dependency": "^1.0.0" },
    })
    await Bun.write(
      path.join(pkg, "index.js"),
      'export { relative } from "./relative.js"\nexport { dependency } from "@fixture/registry-dependency"\n',
    )
    await Bun.write(path.join(pkg, "relative.js"), `export const relative = { value: ${JSON.stringify(version)} }\n`)
    await Bun.$`tar -czf ${path.join(root, "package.tgz")} -C ${root} package`
    tarballs.set(version, await Bun.file(path.join(root, "package.tgz")).bytes())
  }
  for (const version of ["1.0.0", "1.1.0"]) {
    const root = path.join(directory, `dependency-${version}`)
    const pkg = path.join(root, "package")
    await fs.mkdir(pkg, { recursive: true })
    await writePackage(pkg, { name: "@fixture/registry-dependency", version, type: "module", exports: "./index.js" })
    await Bun.write(path.join(pkg, "index.js"), `export const dependency = { value: ${JSON.stringify(version)} }\n`)
    await Bun.$`tar -czf ${path.join(root, "package.tgz")} -C ${root} package`
    tarballs.set(`dependency-${version}`, await Bun.file(path.join(root, "package.tgz")).bytes())
  }
  const state = {
    latest: "1.0.0",
    dependency: "1.0.0",
    requests: 0,
    offline: false,
    beforeTarball: () => Promise.resolve(),
  }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      state.requests++
      if (state.offline) return new Response("offline", { status: 503 })
      if (request.headers.get("authorization") !== "Bearer fixture-only-token")
        return new Response("unauthorized", { status: 401 })
      const url = new URL(request.url)
      if (decodeURIComponent(url.pathname) === "/@fixture/registry-dependency")
        return Response.json({
          name: "@fixture/registry-dependency",
          "dist-tags": { latest: state.dependency },
          versions: Object.fromEntries(
            ["1.0.0", ...(state.dependency === "1.1.0" ? ["1.1.0"] : [])].map((version) => [
              version,
              {
                name: "@fixture/registry-dependency",
                version,
                dist: { tarball: `${url.origin}/tarball/dependency-${version}.tgz` },
              },
            ]),
          ),
        })
      if (decodeURIComponent(url.pathname) === "/@fixture/registry-plugin")
        return Response.json({
          name: "@fixture/registry-plugin",
          "dist-tags": { latest: state.latest },
          versions: Object.fromEntries(
            ["1.0.0", "1.1.0", "1.2.0", "1.3.0"].map((version) => [
              version,
              {
                name: "@fixture/registry-plugin",
                version,
                dependencies: { "@fixture/registry-dependency": "^1.0.0" },
                dist: { tarball: `${url.origin}/tarball/${version}.tgz` },
              },
            ]),
          ),
        })
      const tarball = tarballs.get(url.pathname.replace("/tarball/", "").replace(".tgz", ""))
      if (tarball) await state.beforeTarball()
      return tarball ? new Response(tarball) : new Response("missing tarball", { status: 404 })
    },
  })
  return {
    state,
    async configure(cache: string, spec: string) {
      const root = path.join(cache, "packages", await Npm.cacheKey(spec))
      await fs.mkdir(root, { recursive: true })
      await Bun.write(
        path.join(root, ".npmrc"),
        `registry=${server.url}\n@fixture:registry=${server.url}\n//${server.url.host}/:_authToken=fixture-only-token\ncache=${path.join(directory, "npm-cache")}\nfetch-retries=0\naudit=false\n`,
      )
      return root
    },
    async [Symbol.asyncDispose]() {
      await server.stop(true)
    },
  }
}

const it = testEffect(Layer.empty)

describe("Npm.sanitize", () => {
  test("keeps normal scoped package specs unchanged", () => {
    expect(Npm.sanitize("@opencode/acme")).toBe("@opencode/acme")
    expect(Npm.sanitize("@opencode/acme@1.0.0")).toBe("@opencode/acme@1.0.0")
    expect(Npm.sanitize("prettier")).toBe("prettier")
  })

  test("handles git https specs", () => {
    const spec = "acme@git+https://github.com/opencode/acme.git"
    const expected = win ? "acme@git+https_//github.com/opencode/acme.git" : spec
    expect(Npm.sanitize(spec)).toBe(expected)
  })
})

describe("Npm.isRegistryPackage", () => {
  test("accepts registry packages and rejects unsupported install targets", async () => {
    expect(await Npm.isRegistryPackage("plugin")).toBe(true)
    expect(await Npm.isRegistryPackage("@acme/plugin@beta")).toBe(true)
    expect(await Npm.isRegistryPackage("plugin@^1.2.0")).toBe(true)
    expect(await Npm.isRegistryPackage("./plugin")).toBe(false)
    expect(await Npm.isRegistryPackage("github:acme/plugin")).toBe(false)
    expect(await Npm.isRegistryPackage("alias@npm:plugin@1.0.0")).toBe(false)
  })
})

describe("Npm.isInstallablePackage", () => {
  test("accepts registry and npm-compatible Git specs", async () => {
    expect(await Npm.isInstallablePackage("plugin@^1.2.0")).toBe(true)
    expect(await Npm.isInstallablePackage("github:acme/plugin#main")).toBe(true)
    expect(await Npm.isInstallablePackage("git+ssh://git@github.com/acme/plugin.git#main")).toBe(true)
    expect(await Npm.isInstallablePackage("git@github.com:acme/plugin.git")).toBe(true)
    expect(
      await Npm.isInstallablePackage(
        "git+https://github.com/acme/plugins.git#0123456789abcdef0123456789abcdef01234567::path:packages/plugin",
      ),
    ).toBe(true)
    expect(await Npm.isInstallablePackage("./plugin")).toBe(false)
    expect(await Npm.isInstallablePackage("https://example.com/plugin.tgz")).toBe(false)
    expect(await Npm.isInstallablePackage("alias@npm:plugin@1.0.0")).toBe(false)
  })
})

describe("Npm.cacheKey", () => {
  test("preserves registry keys and hashes Git specs", async () => {
    expect(await Npm.cacheKey("@opencode/acme@1.0.0")).toBe(Npm.sanitize("@opencode/acme@1.0.0"))
    const spec = "git+ssh://git@github.com/acme/plugin.git#main"
    expect(await Npm.cacheKey(spec)).toMatch(/^git-[a-f0-9]{64}$/)
    expect(await Npm.cacheKey(spec)).toBe(await Npm.cacheKey(spec))
    expect(await Npm.cacheKey(`${spec}-other`)).not.toBe(await Npm.cacheKey(spec))
  })
})

describe("Npm.add", () => {
  test("resolves cached scoped package specs without reifying", async () => {
    await using tmp = await tmpdir()
    const spec = "@fixture/provider@1.0.0"
    const directory = path.join(
      tmp.path,
      "cache",
      "packages",
      Npm.sanitize(spec),
      "node_modules",
      "@fixture",
      "provider",
    )
    await fs.mkdir(directory, { recursive: true })
    await writePackage(directory, { name: "@fixture/provider", exports: "./index.js" })
    await Bun.write(path.join(directory, "index.js"), "export const fixture = true\n")

    const entry = await Effect.gen(function* () {
      const npm = yield* Npm.Service
      return yield* npm.add(spec)
    }).pipe(Effect.scoped, Effect.provide(npmLayer(path.join(tmp.path, "cache"))), Effect.runPromise)

    expect(entry.directory).toBe(directory)
    expect(entry.entrypoint).toEndWith("/index.js")
  })

  test("falls back to the original spec when parsing fails", async () => {
    await using tmp = await tmpdir()
    const spec = "fixture provider"
    const directory = path.join(tmp.path, "cache", "packages", Npm.sanitize(spec), "node_modules", spec)
    await fs.mkdir(directory, { recursive: true })
    await writePackage(directory, { name: spec, exports: "./index.js" })
    await Bun.write(path.join(directory, "index.js"), "export const fixture = true\n")

    const entry = await Effect.gen(function* () {
      const npm = yield* Npm.Service
      return yield* npm.add(spec)
    }).pipe(Effect.scoped, Effect.provide(npmLayer(path.join(tmp.path, "cache"))), Effect.runPromise)

    expect(entry.directory).toBe(directory)
    expect(entry.entrypoint).toEndWith("/index.js")
  })

  test("reifies when package cache directory exists without the package installed", async () => {
    await using tmp = await tmpdir()
    await fs.mkdir(path.join(tmp.path, "fixture-provider"))
    await writePackage(path.join(tmp.path, "fixture-provider"), {
      name: "fixture-provider",
      exports: {
        ".": "./index.js",
        "./tui": "./tui.js",
      },
    })
    await Bun.write(path.join(tmp.path, "fixture-provider", "index.js"), "export const fixture = true\n")
    await Bun.write(path.join(tmp.path, "fixture-provider", "tui.js"), "export const tui = true\n")

    const spec = `fixture-provider@file:${path.join(tmp.path, "fixture-provider")}`
    await fs.mkdir(path.join(tmp.path, "cache", "packages", Npm.sanitize(spec)), { recursive: true })

    const entries = await Effect.gen(function* () {
      const npm = yield* Npm.Service
      return {
        tui: yield* npm.add(spec, { subpaths: ["tui", ""] }),
        fallback: yield* npm.add(spec, { subpaths: ["missing", ""] }),
      }
    }).pipe(Effect.scoped, Effect.provide(npmLayer(path.join(tmp.path, "cache"))), Effect.runPromise)

    expect(entries.tui.entrypoint).toEndWith("/tui.js")
    expect(entries.fallback.entrypoint).toEndWith("/index.js")
  })

  test("installs and resolves named and unnamed Git packages with dependencies", async () => {
    await using tmp = await tmpdir()
    const fixture = await createGitFixture(tmp.path)
    const cache = path.join(tmp.path, "cache")
    const specs = [
      `git+file://${fixture.repository}#${fixture.commit}`,
      `fixture-named-plugin@git+file://${fixture.repository}#fixture-branch`,
    ]

    for (const spec of specs) {
      const entries = await Effect.gen(function* () {
        const npm = yield* Npm.Service
        return {
          added: yield* npm.add(spec),
          cached: yield* npm.add(spec),
          resolved: yield* npm.resolve(spec),
        }
      }).pipe(Effect.scoped, Effect.provide(npmLayer(cache)), Effect.runPromise)

      expect(entries.added.entrypoint).toEndWith("/index.js")
      expect(entries.cached).toEqual(entries.added)
      expect(entries.resolved).toEqual(entries.added)
      expect(
        await fs.stat(path.join(path.dirname(entries.added.directory), "fixture-dependency", "package.json")),
      ).toBeTruthy()
      expect(entries.added.directory).toContain(
        path.join("packages", await Npm.cacheKey(spec), "generations", entries.added.generation, "node_modules"),
      )
      expect(entries.added.revision).toBe(fixture.commit)
    }
  })

  test("installs a Git package from an npm ::path: subdirectory", async () => {
    await using tmp = await tmpdir()
    const fixture = await createGitFixture(tmp.path)
    const spec = `git+file://${fixture.repository}#${fixture.commit}::path:packages/subdirectory-plugin`
    const entry = await Effect.gen(function* () {
      const npm = yield* Npm.Service
      return yield* npm.add(spec)
    }).pipe(Effect.scoped, Effect.provide(npmLayer(path.join(tmp.path, "cache"))), Effect.runPromise)

    expect(entry.directory).toEndWith(path.join("node_modules", "fixture-subdirectory-plugin"))
    expect(entry.entrypoint).toEndWith("/index.js")
    expect(
      await fs.stat(path.join(path.dirname(entry.directory), "fixture-subdirectory-dependency", "package.json")),
    ).toBeTruthy()
    await advanceGitFixture(fixture.repository, "second")
    const exact = await Effect.gen(function* () {
      const npm = yield* Npm.Service
      return yield* npm.add(`git+file://${fixture.repository}#fixture-branch::path:packages/subdirectory-plugin`, {
        revision: fixture.commit,
      })
    }).pipe(Effect.provide(npmLayer(path.join(tmp.path, "cache"))), Effect.runPromise)
    expect(exact.revision).toBe(fixture.commit)
    expect(exact.directory).toEndWith(path.join("node_modules", "fixture-subdirectory-plugin"))
  })

  // Several real Git installs and refreshes exceed Bun's default timeout on Windows.
  test("refreshes mutable Git packages once per service lifetime and preserves pinned or cached installs", async () => {
    await using tmp = await tmpdir()
    const fixture = await createGitFixture(tmp.path)
    const cache = path.join(tmp.path, "cache")
    const repository = pathToFileURL(fixture.repository).href
    const mutable = `git+${repository}#fixture-branch`
    const pinned = `git+${repository}#${fixture.commit}`

    const first = await Effect.gen(function* () {
      const npm = yield* Npm.Service
      const mutableEntry = yield* npm.add(mutable, { refresh: true })
      const pinnedEntry = yield* npm.add(pinned, { refresh: true })
      yield* Effect.promise(async () => {
        await Bun.write(path.join(fixture.repository, "index.js"), 'export default { root: "second" }\n')
        await Bun.$`git -C ${fixture.repository} add .`
        await Bun.$`git -C ${fixture.repository} -c user.name=fixture -c user.email=fixture@example.com commit -qm second`
      })
      yield* npm.add(mutable, { refresh: true })
      return { mutable: mutableEntry, pinned: pinnedEntry }
    }).pipe(Effect.scoped, Effect.provide(npmLayer(cache)), Effect.runPromise)
    expect(await Bun.file(path.join(first.mutable.directory, "index.js")).text()).toContain("root: true")
    expect(await Bun.file(path.join(first.pinned.directory, "index.js")).text()).toContain("root: true")

    const second = await Effect.gen(function* () {
      const npm = yield* Npm.Service
      return {
        mutable: yield* npm.add(mutable, { refresh: true }),
        pinned: yield* npm.add(pinned, { refresh: true }),
      }
    }).pipe(Effect.scoped, Effect.provide(npmLayer(cache)), Effect.runPromise)
    expect(await Bun.file(path.join(second.mutable.directory, "index.js")).text()).toContain('root: "second"')
    expect(await Bun.file(path.join(second.pinned.directory, "index.js")).text()).toContain("root: true")

    await fs.rename(fixture.repository, `${fixture.repository}-offline`)
    const offline = await Effect.gen(function* () {
      const npm = yield* Npm.Service
      return yield* npm.add(mutable, { refresh: true })
    }).pipe(Effect.scoped, Effect.provide(npmLayer(cache)), Effect.runPromise)
    expect(await Bun.file(path.join(offline.directory, "index.js")).text()).toContain('root: "second"')
  }, 30_000)
})

describe("Npm.resolve", () => {
  test("resolves a TUI entrypoint only when the package is already cached", async () => {
    await using tmp = await tmpdir()
    const cache = path.join(tmp.path, "cache")
    const spec = "fixture-plugin@1.0.0"
    const directory = path.join(cache, "packages", Npm.sanitize(spec), "node_modules", "fixture-plugin")
    const missing = await Effect.gen(function* () {
      const npm = yield* Npm.Service
      return yield* npm.resolve(spec, { subpaths: ["tui"] })
    }).pipe(Effect.scoped, Effect.provide(npmLayer(cache)), Effect.runPromise)
    expect(missing.entrypoint).toBeUndefined()

    await fs.mkdir(directory, { recursive: true })
    await writePackage(directory, {
      name: "fixture-plugin",
      exports: { ".": "./index.js", "./tui": "./tui.js" },
    })
    await Bun.write(path.join(directory, "index.js"), "export default {}\n")
    await Bun.write(path.join(directory, "tui.js"), "export default {}\n")

    const resolved = await Effect.gen(function* () {
      const npm = yield* Npm.Service
      return yield* npm.resolve(spec, { subpaths: ["tui"] })
    }).pipe(Effect.scoped, Effect.provide(npmLayer(cache)), Effect.runPromise)
    expect(resolved.entrypoint).toEndWith("/tui.js")
  })
})

describe("Npm generations", () => {
  it.live(
    "loads the cached immutable graph while an updater holds the install lock",
    withTempDir((tmp) =>
      Effect.gen(function* () {
        const fixture = yield* Effect.acquireRelease(
          Effect.promise(() => createRegistryFixture(tmp.path)),
          (fixture) => Effect.promise(() => fixture[Symbol.asyncDispose]()),
        )
        const cache = path.join(tmp.path, "cache")
        const spec = "@fixture/registry-plugin@latest"
        yield* Effect.promise(() => fixture.configure(cache, spec))
        yield* Effect.gen(function* () {
          const npm = yield* Npm.Service
          const first = yield* npm.add(spec, { refresh: true })
          fixture.state.latest = "1.1.0"
          fixture.state.dependency = "1.1.0"
          const started = Promise.withResolvers<void>()
          const resume = Promise.withResolvers<void>()
          fixture.state.beforeTarball = () => {
            started.resolve()
            return resume.promise
          }
          const updating = yield* npm.update(spec).pipe(Effect.forkScoped)
          yield* Effect.gen(function* () {
            yield* Effect.promise(() => started.promise).pipe(Effect.timeout("5 seconds"))
            const adding = yield* Effect.all([
              npm.add(spec),
              npm.add(spec, { revision: first.revision, subpaths: ["tui"] }),
              npm.add(spec, { refresh: true }),
            ]).pipe(Effect.forkScoped)
            // Timeout the join, not uninterruptible lock acquisition; release the updater before scoped cleanup.
            expect(yield* Fiber.join(adding).pipe(Effect.timeout("5 seconds"))).toEqual([first, first, first])
            expect(updating.pollUnsafe()).toBeUndefined()
          }).pipe(Effect.ensuring(Effect.sync(() => resume.resolve())))
          const updated = yield* Fiber.join(updating)
          expect(updated.revision).toBe("1.1.0")
          expect(updated.generation).not.toBe(first.generation)
          expect(yield* npm.add(spec)).toEqual(updated)
          const retained = yield* Effect.promise(() => import(first.entrypoint ?? ""))
          expect(retained.relative.value).toBe("1.0.0")
          expect(retained.dependency.value).toBe("1.0.0")
        }).pipe(Effect.provide(npmLayer(cache)))
      }),
    ),
    30_000,
  )

  it.live(
    "reloads the retained local generation when the same npm revision acquired a different dependency graph",
    withTempDir((tmp) =>
      Effect.gen(function* () {
        const fixture = yield* Effect.acquireRelease(
          Effect.promise(() => createRegistryFixture(tmp.path)),
          (fixture) => Effect.promise(() => fixture[Symbol.asyncDispose]()),
        )
        const cache = path.join(tmp.path, "cache")
        const spec = "@fixture/registry-plugin@latest"
        const pinned = "@fixture/registry-plugin@1.0.0"
        const root = yield* Effect.promise(() => fixture.configure(cache, spec))
        yield* Effect.promise(() => fixture.configure(cache, pinned))
        const entries = yield* Effect.gen(function* () {
          const npm = yield* Npm.Service
          const first = yield* npm.add(spec)
          const loaded = yield* Effect.promise(() => import(first.entrypoint ?? ""))
          expect(loaded.dependency.value).toBe("1.0.0")
          fixture.state.dependency = "1.1.0"
          const second = yield* npm.update(spec)
          expect(second.revision).toBe(first.revision)
          expect(second.generation).not.toBe(first.generation)
          expect((yield* Effect.promise(() => import(second.entrypoint ?? ""))).dependency.value).toBe("1.1.0")
          expect(yield* npm.resolve(spec, { revision: first.revision })).toEqual(second)
          const foreign = yield* npm.add(pinned)
          return { first, second, foreign, loaded }
        }).pipe(Effect.provide(npmLayer(cache)))
        fixture.state.offline = true
        const requests = fixture.state.requests
        yield* Effect.gen(function* () {
          const npm = yield* Npm.Service
          expect(yield* npm.resolve(spec)).toEqual(entries.second)
          expect((yield* npm.reload(spec, { generation: "../../outside" }).pipe(Effect.flip))._tag).toBe(
            "NpmInstallFailedError",
          )
          expect((yield* npm.reload(spec, { generation: entries.foreign.generation }).pipe(Effect.flip))._tag).toBe(
            "NpmInstallFailedError",
          )
          expect(
            (yield* npm.reload(spec, { generation: entries.first.generation, revision: "1.1.0" }).pipe(Effect.flip))
              ._tag,
          ).toBe("NpmInstallFailedError")
          expect(yield* npm.resolve(spec)).toEqual(entries.second)
          const reloaded = yield* npm.reload(spec, {
            generation: entries.first.generation,
            revision: entries.first.revision,
          })
          expect(reloaded.revision).toBe(entries.first.revision)
          expect(reloaded.generation).not.toBe(entries.first.generation)
          const fresh = yield* Effect.promise(() => import(reloaded.entrypoint ?? ""))
          expect(fresh.dependency.value).toBe("1.0.0")
          expect(fresh.dependency).not.toBe(entries.loaded.dependency)
          expect(yield* npm.resolve(spec)).toEqual(reloaded)
          expect(fixture.state.requests).toBe(requests)
          expect(
            yield* Effect.promise(() =>
              Bun.file(path.join(root, "generations", entries.first.generation, "generation.json")).json(),
            ),
          ).toEqual({ name: "@fixture/registry-plugin", generation: entries.first.generation, revision: "1.0.0" })
          expect(
            yield* Effect.promise(() =>
              Bun.file(path.join(path.dirname(entries.second.directory), "registry-dependency", "index.js")).text(),
            ),
          ).toContain('"1.1.0"')
        }).pipe(Effect.provide(npmLayer(cache)))
      }),
    ),
    30_000,
  )

  it.live(
    "defers cancellation through publication without removing the committed generation",
    withTempDir((tmp) =>
      Effect.gen(function* () {
        const fixture = yield* Effect.acquireRelease(
          Effect.promise(() => createRegistryFixture(tmp.path)),
          (fixture) => Effect.promise(() => fixture[Symbol.asyncDispose]()),
        )
        const cache = path.join(tmp.path, "cache")
        const spec = "@fixture/registry-plugin@latest"
        const root = yield* Effect.promise(() => fixture.configure(cache, spec))
        yield* Effect.gen(function* () {
          const npm = yield* Npm.Service
          const first = yield* npm.add(spec)
          fixture.state.latest = "1.1.0"
          const started = Promise.withResolvers<void>()
          const resume = Promise.withResolvers<void>()
          fixture.state.beforeTarball = () => {
            started.resolve()
            return resume.promise
          }
          const updating = yield* npm.update(spec).pipe(Effect.forkScoped)
          yield* Effect.promise(() => started.promise)
          updating.interruptUnsafe()
          expect(updating.pollUnsafe()).toBeUndefined()
          resume.resolve()
          const exit = yield* Fiber.await(updating)
          expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
          // The pending interrupt is observed after publication, outside staging's cleanup boundary.
          const published = yield* npm.resolve(spec)
          expect(published.revision).toBe("1.1.0")
          expect(published.generation).not.toBe(first.generation)
          expect((yield* Effect.promise(() => import(published.entrypoint ?? ""))).relative.value).toBe("1.1.0")
          expect(yield* Effect.promise(() => Bun.file(path.join(first.directory, "relative.js")).text())).toContain(
            '"1.0.0"',
          )
          expect((yield* Effect.promise(() => fs.readdir(path.join(root, "generations")))).length).toBe(2)
        }).pipe(Effect.provide(npmLayer(cache)))
      }),
    ),
    30_000,
  )

  it.live(
    "finds binaries in published generations and keeps their old files usable after reload",
    withTempDir((tmp) =>
      Effect.gen(function* () {
        const fixture = path.join(tmp.path, "binary")
        yield* Effect.promise(async () => {
          await fs.mkdir(fixture)
          await writePackage(fixture, {
            name: "fixture-bin",
            bin: { "fixture-bin": "./cli.js", "fixture-other": "./other.js" },
          })
          await Bun.write(path.join(fixture, "cli.js"), '#!/usr/bin/env node\nconsole.log(require("./value.cjs"))\n')
          await Bun.write(path.join(fixture, "value.cjs"), 'module.exports = "fixture"\n')
          await Bun.write(path.join(fixture, "other.js"), '#!/usr/bin/env node\nconsole.log("other")\n')
        })
        const spec = `fixture-bin@file:${fixture}`
        const cache = path.join(tmp.path, "cache")
        yield* Effect.gen(function* () {
          const npm = yield* Npm.Service
          const binary = yield* npm.which(spec)
          expect(binary).toEndWith(path.join(".bin", "fixture-bin"))
          expect(yield* npm.which(spec, "fixture-other")).toEndWith(path.join(".bin", "fixture-other"))
          expect(yield* npm.which(spec, "missing")).toBeUndefined()
          const original = yield* npm.resolve(spec)
          const reloaded = yield* npm.reload(spec)
          expect(reloaded.generation).not.toBe(original.generation)
          const fresh = yield* npm.which(spec)
          expect(fresh).not.toBe(binary)
          expect(fresh).toContain(reloaded.generation)
          expect(yield* Effect.promise(() => Bun.file(binary ?? "").text())).toContain("value.cjs")
          expect(yield* Effect.promise(() => Bun.file(fresh ?? "").text())).toContain("value.cjs")
          if (!win)
            yield* Effect.promise(async () => {
              const child = Bun.spawn([process.execPath, fresh ?? ""], { stdout: "pipe", stderr: "pipe" })
              expect(await child.exited, await new Response(child.stderr).text()).toBe(0)
              expect(await new Response(child.stdout).text()).toBe("fixture\n")
            })
        }).pipe(Effect.provide(npmLayer(cache)))
      }),
    ),
  )

  it.live(
    "checks without changing files, updates repeatedly, preserves pins, and reloads the whole Git graph offline",
    withTempDir((tmp) =>
      Effect.gen(function* () {
        const fixture = yield* Effect.promise(() => createGitFixture(tmp.path))
        const cache = path.join(tmp.path, "cache")
        const spec = `git+${pathToFileURL(fixture.repository).href}#fixture-branch`
        const pinned = `git+${pathToFileURL(fixture.repository).href}#${fixture.commit}`
        const entries = yield* Effect.gen(function* () {
          const npm = yield* Npm.Service
          const first = yield* npm.add(spec, { refresh: true })
          const pin = yield* npm.add(pinned)
          const firstModule = yield* Effect.promise(() => import(first.entrypoint ?? ""))
          expect(firstModule.relative.value).toBe("first")
          expect(firstModule.dependency.value).toBe("first")
          const secondCommit = yield* Effect.promise(() => advanceGitFixture(fixture.repository, "second"))
          expect(yield* npm.check(spec)).toEqual({ installed: fixture.commit, available: secondCommit, mutable: true })
          expect(yield* npm.resolve(spec)).toEqual(first)
          expect(yield* npm.add(spec, { refresh: true })).toEqual(first)
          const second = yield* npm.update(spec)
          expect(second.revision).toBe(secondCommit)
          const secondModule = yield* Effect.promise(() => import(second.entrypoint ?? ""))
          expect(secondModule.relative.value).toBe("second")
          expect(secondModule.dependency.value).toBe("second")
          expect(second.generation).not.toBe(first.generation)
          const thirdCommit = yield* Effect.promise(() => advanceGitFixture(fixture.repository, "third"))
          const third = yield* npm.update(spec)
          expect(third.revision).toBe(thirdCommit)
          const thirdModule = yield* Effect.promise(() => import(third.entrypoint ?? ""))
          expect(thirdModule.relative.value).toBe("third")
          expect(thirdModule.dependency.value).toBe("third")
          const thirdCjs = yield* npm.resolve(spec, { subpaths: ["cjs"] })
          const thirdCommonJs = yield* Effect.promise(() => import(thirdCjs.entrypoint ?? ""))
          expect(thirdCommonJs.default.relative.value).toBe("third")
          expect(thirdCommonJs.default.dependency.value).toBe("third")
          expect(yield* npm.check(pinned)).toEqual({
            installed: fixture.commit,
            available: fixture.commit,
            mutable: false,
          })
          expect(yield* npm.update(pinned)).toEqual(pin)
          const companionCommit = yield* Effect.promise(() => advanceGitFixture(fixture.repository, "companion"))
          const companion = yield* npm.add(spec, { revision: companionCommit })
          expect(companion.revision).toBe(companionCommit)
          expect((yield* Effect.promise(() => import(companion.entrypoint ?? ""))).dependency.value).toBe("companion")
          expect(yield* npm.resolve(spec)).toEqual(third)
          expect(yield* npm.resolve(spec, { revision: companionCommit })).toEqual(companion)
          yield* Effect.promise(() => fs.rename(fixture.repository, `${fixture.repository}-offline`))
          const root = path.join(cache, "packages", yield* Effect.promise(() => Npm.cacheKey(spec)))
          const before = yield* Effect.promise(() => fs.readdir(path.join(root, "generations")))
          expect((yield* npm.update(spec).pipe(Effect.flip))._tag).toBe("NpmInstallFailedError")
          expect(yield* Effect.promise(() => fs.readdir(path.join(root, "generations")))).toEqual(before)
          expect(yield* npm.resolve(spec)).toEqual(third)
          const reloaded = yield* npm.reload(spec)
          expect(reloaded.revision).toBe(thirdCommit)
          expect(reloaded.generation).not.toBe(third.generation)
          const reloadedModule = yield* Effect.promise(() => import(reloaded.entrypoint ?? ""))
          expect(reloadedModule.relative).toEqual(thirdModule.relative)
          expect(reloadedModule.relative).not.toBe(thirdModule.relative)
          expect(reloadedModule.dependency).not.toBe(thirdModule.dependency)
          const freshCjs = yield* npm.resolve(spec, { subpaths: ["cjs"] })
          const freshCommonJs = yield* Effect.promise(() => import(freshCjs.entrypoint ?? ""))
          expect(freshCommonJs.default.relative).not.toBe(thirdCommonJs.default.relative)
          expect(freshCommonJs.default.dependency).not.toBe(thirdCommonJs.default.dependency)
          const exactReload = yield* npm.reload(spec, { revision: companionCommit })
          expect(exactReload.revision).toBe(companionCommit)
          expect(yield* npm.resolve(spec)).toEqual(reloaded)
          expect(yield* npm.update(pinned)).toEqual(pin)
          expect(yield* Effect.promise(() => Bun.file(path.join(first.directory, "relative.js")).text())).toContain(
            '"first"',
          )
          expect(yield* Effect.promise(() => Bun.file(path.join(second.directory, "relative.js")).text())).toContain(
            '"second"',
          )
          return { first, third, reloaded, exactReload, thirdCjs, freshCjs }
        }).pipe(Effect.provide(npmLayer(cache)))
        yield* Effect.gen(function* () {
          const npm = yield* Npm.Service
          expect(yield* npm.resolve(spec)).toEqual(entries.reloaded)
          expect(yield* npm.inspect(spec)).toEqual({ installed: entries.third.revision, mutable: true })
          expect(yield* npm.resolve(spec, { revision: entries.exactReload.revision })).toEqual(entries.exactReload)
        }).pipe(Effect.provide(npmLayer(cache)))
        // Exercise the same realpaths in Node's ESM loader as well as Bun's loader above.
        const node = Bun.which("node")
        if (node)
          yield* Effect.promise(async () => {
            const script = `
        import assert from "node:assert/strict";
        const first = await import(${JSON.stringify(entries.first.entrypoint)});
        const third = await import(${JSON.stringify(entries.third.entrypoint)});
        const fresh = await import(${JSON.stringify(entries.reloaded.entrypoint)});
        assert.equal(first.relative.value, "first");
        assert.equal(third.relative.value, "third");
        assert.equal(third.dependency.value, "third");
        assert.notEqual(fresh.relative, third.relative);
        assert.notEqual(fresh.dependency, third.dependency);
        const thirdCjs = await import(${JSON.stringify(entries.thirdCjs.entrypoint)});
        const freshCjs = await import(${JSON.stringify(entries.freshCjs.entrypoint)});
        assert.equal(thirdCjs.default.relative.value, "third");
        assert.equal(thirdCjs.default.dependency.value, "third");
        assert.notEqual(freshCjs.default.relative, thirdCjs.default.relative);
        assert.notEqual(freshCjs.default.dependency, thirdCjs.default.dependency);
      `
            const child = Bun.spawn([node, "--input-type=module", "-e", script], { stdout: "pipe", stderr: "pipe" })
            expect(await child.exited, await new Response(child.stderr).text()).toBe(0)
          })
      }),
    ),
    30_000,
  )

  it.live(
    "auto-refreshes a legacy Git install once without overwriting it",
    withTempDir((tmp) =>
      Effect.gen(function* () {
        const fixture = yield* Effect.promise(() => createGitFixture(tmp.path))
        const cache = path.join(tmp.path, "cache")
        const spec = `git+${pathToFileURL(fixture.repository).href}#fixture-branch`
        const root = path.join(cache, "packages", yield* Effect.promise(() => Npm.cacheKey(spec)))
        const initial = yield* Effect.gen(function* () {
          const npm = yield* Npm.Service
          return yield* npm.add(spec)
        }).pipe(Effect.provide(npmLayer(cache)))
        yield* Effect.promise(async () => {
          // Recreate the shipped pre-generation cache layout, including its real npm lockfile.
          await fs.cp(path.join(root, "generations", initial.generation), root, { recursive: true, dereference: true })
          await fs.rm(path.join(root, "current.json"))
          await fs.rm(path.join(root, "revisions"), { recursive: true })
          await fs.rm(path.join(root, "generations"), { recursive: true })
        })
        const secondCommit = yield* Effect.promise(() => advanceGitFixture(fixture.repository, "second"))
        yield* Effect.gen(function* () {
          const npm = yield* Npm.Service
          const legacy = yield* npm.resolve(spec)
          expect(legacy.revision).toBe(fixture.commit)
          expect(legacy.generation).toStartWith("legacy-")
          const updated = yield* npm.add(spec, { refresh: true })
          expect(updated.revision).toBe(secondCommit)
          expect(updated.directory).not.toBe(legacy.directory)
          yield* Effect.promise(() => advanceGitFixture(fixture.repository, "third"))
          expect(yield* npm.add(spec, { refresh: true })).toEqual(updated)
          expect(yield* Effect.promise(() => Bun.file(path.join(legacy.directory, "relative.js")).text())).toContain(
            '"first"',
          )
          yield* Effect.promise(() => fs.rename(fixture.repository, `${fixture.repository}-offline`))
          const reloaded = yield* npm.reload(spec, { generation: legacy.generation, revision: legacy.revision })
          expect(reloaded.revision).toBe(fixture.commit)
          expect((yield* Effect.promise(() => import(reloaded.entrypoint ?? ""))).dependency.value).toBe("first")
          expect(yield* npm.resolve(spec)).toEqual(updated)
        }).pipe(Effect.provide(npmLayer(cache)))
      }),
    ),
    30_000,
  )

  it.live(
    "uses npm configuration, stages exact registry revisions, and retains the old graph after a failed tarball",
    withTempDir((tmp) =>
      Effect.gen(function* () {
        const fixture = yield* Effect.acquireRelease(
          Effect.promise(() => createRegistryFixture(tmp.path)),
          (fixture) => Effect.promise(() => fixture[Symbol.asyncDispose]()),
        )
        const cache = path.join(tmp.path, "cache")
        const spec = "@fixture/registry-plugin@latest"
        const pinned = "@fixture/registry-plugin@1.0.0"
        const root = yield* Effect.promise(() => fixture.configure(cache, spec))
        yield* Effect.promise(() => fixture.configure(cache, pinned))
        const updated = yield* Effect.gen(function* () {
          const npm = yield* Npm.Service
          expect(yield* npm.inspect(spec)).toEqual({ installed: undefined, mutable: true })
          expect(yield* npm.check(spec)).toEqual({ installed: undefined, available: "1.0.0", mutable: true })
          expect((yield* npm.resolve(spec)).entrypoint).toBeUndefined()
          const first = yield* npm.add(spec, { refresh: true })
          const pin = yield* npm.add(pinned)
          const firstModule = yield* Effect.promise(() => import(first.entrypoint ?? ""))
          fixture.state.latest = "1.1.0"
          expect(yield* npm.check(spec)).toEqual({ installed: "1.0.0", available: "1.1.0", mutable: true })
          expect(yield* npm.resolve(spec)).toEqual(first)
          const second = yield* npm.update(spec, { subpaths: [""] })
          expect(second.revision).toBe("1.1.0")
          expect((yield* Effect.promise(() => import(second.entrypoint ?? ""))).relative.value).toBe("1.1.0")
          expect((yield* npm.update(spec, { subpaths: ["missing"] }).pipe(Effect.flip))._tag).toBe(
            "NpmInstallFailedError",
          )
          expect(yield* npm.resolve(spec)).toEqual(second)
          const companion = yield* npm.add(spec, { revision: "1.2.0", subpaths: ["tui"] })
          expect(companion.revision).toBe("1.2.0")
          expect(yield* npm.resolve(spec)).toEqual(second)
          fixture.state.latest = "1.3.0"
          expect((yield* npm.check(spec)).available).toBe("1.3.0")
          const before = yield* Effect.promise(() => fs.readdir(path.join(root, "generations")))
          expect((yield* npm.update(spec).pipe(Effect.flip))._tag).toBe("NpmInstallFailedError")
          expect(yield* Effect.promise(() => fs.readdir(path.join(root, "generations")))).toEqual(before)
          expect(yield* npm.resolve(spec)).toEqual(second)
          expect((yield* npm.add(spec, { revision: "latest" }).pipe(Effect.flip))._tag).toBe("NpmInstallFailedError")
          const requests = fixture.state.requests
          fixture.state.offline = true
          expect(yield* npm.check(pinned)).toEqual({ installed: "1.0.0", available: "1.0.0", mutable: false })
          expect(yield* npm.update(pinned)).toEqual(pin)
          const reloaded = yield* npm.reload(spec)
          expect(reloaded.revision).toBe("1.1.0")
          expect(fixture.state.requests).toBe(requests)
          expect((yield* Effect.promise(() => import(reloaded.entrypoint ?? ""))).relative.value).toBe("1.1.0")
          expect(firstModule.relative.value).toBe("1.0.0")
          expect(yield* Effect.promise(() => Bun.file(path.join(first.directory, "relative.js")).text())).toContain(
            '"1.0.0"',
          )
          return reloaded
        }).pipe(Effect.provide(npmLayer(cache)))
        yield* Effect.gen(function* () {
          const npm = yield* Npm.Service
          expect(yield* npm.resolve(spec)).toEqual(updated)
          expect((yield* npm.resolve(spec, { revision: "1.2.0" })).revision).toBe("1.2.0")
        }).pipe(Effect.provide(npmLayer(cache)))
      }),
    ),
    30_000,
  )
})
