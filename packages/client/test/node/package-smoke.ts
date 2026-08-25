import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { join, relative, resolve } from "node:path"
import { pathToFileURL } from "node:url"

const directory = resolve(import.meta.dir, "../..")

test("built Node entrypoint imports and exposes browser registration in Node", async () => {
  const build = Bun.spawn([process.execPath, "run", "build"], { cwd: directory, stdout: "pipe", stderr: "pipe" })
  const [status, stdout, stderr] = await Promise.all([
    build.exited,
    new Response(build.stdout).text(),
    new Response(build.stderr).text(),
  ])
  if (status !== 0) throw new Error(stdout + stderr)
  const output = await Bun.file(join(directory, "dist/node/index.js")).text()
  expect(output).not.toMatch(/(?:from\s+|import\s*)["']\.\.?\//)

  const temporary = await mkdtemp(join(import.meta.dir, ".node-package-"))
  try {
    const schema = join(temporary, "node_modules/@opencode-ai/schema")
    const protocol = join(temporary, "node_modules/@opencode-ai/protocol")
    await Promise.all([mkdir(schema, { recursive: true }), mkdir(protocol, { recursive: true })])
    const entries = [
      {
        directory: schema,
        source: "schema.ts",
        exports: ["browser", "browser-control", "browser-tunnel", "session"],
        statements: [
          ["Browser", "browser"],
          ["BrowserControl", "browser-control"],
          ["BrowserTunnel", "browser-tunnel"],
          ["Session", "session"],
        ],
      },
      {
        directory: protocol,
        source: "protocol.ts",
        exports: ["browser-control", "browser-tunnel"],
        statements: [
          ["BrowserControlProtocol", "browser-control"],
          ["BrowserTunnelProtocol", "browser-tunnel"],
        ],
      },
    ]
    await Promise.all(
      entries.map(async (entry) => {
        const source = join(temporary, entry.source)
        await Bun.write(
          source,
          entry.statements
            .map(([name, path]) => {
              const target = relative(
                temporary,
                resolve(directory, `../${entry.source.replace(".ts", "")}/src/${path}.ts`),
              ).replaceAll("\\", "/")
              return `export { ${name} } from ${JSON.stringify(target.startsWith(".") ? target : `./${target}`)}`
            })
            .join("\n"),
        )
        const result = await Bun.build({
          entrypoints: [source],
          outdir: entry.directory,
          naming: "index.js",
          target: "node",
          format: "esm",
          packages: "bundle",
        })
        if (!result.success) throw new Error(result.logs.map((log) => log.message).join("\n"))
        await Bun.write(
          join(entry.directory, "package.json"),
          JSON.stringify({
            type: "module",
            exports: Object.fromEntries(entry.exports.map((path) => [`./${path}`, "./index.js"])),
          }),
        )
      }),
    )
    await Bun.write(join(temporary, "index.mjs"), output)
    const scenario = `const sdk = await import(${JSON.stringify(pathToFileURL(join(temporary, "index.mjs")).href)})
if (typeof sdk.OpenCode.make !== "function") throw new Error("Missing OpenCode.make")
if (typeof sdk.BrowserDriver.define !== "function") throw new Error("Missing BrowserDriver.define")
if (typeof sdk.BrowserDriver.chromium !== "function") throw new Error("Missing BrowserDriver.chromium")
if (typeof sdk.BrowserDriverError !== "function") throw new Error("Missing BrowserDriverError")
if (!sdk.Browser.State) throw new Error("Missing canonical Browser export")
if (typeof sdk.OpenCode.make({ baseUrl: "http://127.0.0.1:1" }).browser.register !== "function") throw new Error("Missing browser.register")
console.log("ok")`
    const child = Bun.spawn(["node", "--input-type=module", "-e", scenario], {
      cwd: temporary,
      stdout: "pipe",
      stderr: "pipe",
    })
    const [exitCode, result, error] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    if (exitCode !== 0) throw new Error(error || result)
    expect(result.trim()).toBe("ok")
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}, 60_000)
