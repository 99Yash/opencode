import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import { createPluginHost } from "../src/plugin-host"

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => Bun.$`rm -rf ${directory}`.quiet()))
})

describe("plugin host", () => {
  test("loads the tui export from a local package", async () => {
    const directory = await temp()
    await Bun.write(
      path.join(directory, "package.json"),
      JSON.stringify({ type: "module", exports: { "./tui": "./src/tui.js" } }),
    )
    await Bun.write(
      path.join(directory, "src/tui.js"),
      "export default { id: 'example.tui', setup() { return () => {} } }",
    )

    const plugin = await createPluginHost(async () => undefined).load(directory, directory)

    expect(plugin?.id).toBe("example.tui")
  })

  test("loads a package resolver tui entrypoint", async () => {
    const directory = await temp()
    const entrypoint = path.join(directory, "tui.js")
    await Bun.write(entrypoint, "export default { id: 'npm.tui', setup() {} }")

    const plugin = await createPluginHost(async (spec) => {
      expect(spec).toBe("example-plugin")
      return entrypoint
    }).load("example-plugin", directory)

    expect(plugin?.id).toBe("npm.tui")
  })

  test("reports invalid tui exports without terminating the host", async () => {
    const directory = await temp()
    const entrypoint = path.join(directory, "tui.js")
    await Bun.write(entrypoint, "export default { id: 'invalid' }")
    const host = createPluginHost(async () => entrypoint)

    expect(host.load("invalid-plugin", directory)).rejects.toThrow("Invalid V2 TUI plugin module: invalid-plugin")
    expect(await host.load("unsupported-plugin", directory).catch(() => undefined)).toBeUndefined()
  })
})

async function temp() {
  const directory = await Bun.$`mktemp -d`.text()
  directories.push(directory.trim())
  return directory.trim()
}
