import { expect, test } from "bun:test"
import { createComponent, createSignal, type JSX } from "solid-js"
import { testRender } from "@opentui/solid"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { preparePlugin } from "../src/plugin/loader.bun"
import "../src/plugin/runtime-plugin-support.bun"
import { tmpdir } from "./fixture/fixture"

test("an external TSX plugin uses the host Solid runtime", async () => {
  await using tmp = await tmpdir()
  const root = path.join(tmp.path, ".opencode")
  const source = path.join(root, "plugins", "tui", "reactive.tsx")
  const helper = path.join(root, "plugins", "tui", "signal.ts")
  const localSolid = path.join(root, "node_modules", "solid-js")
  const localOpenTui = path.join(root, "node_modules", "@opentui", "solid")
  await Promise.all([
    mkdir(path.dirname(source), { recursive: true }),
    mkdir(localSolid, { recursive: true }),
    mkdir(localOpenTui, { recursive: true }),
  ])
  await Promise.all([
    writeFile(
      path.join(localSolid, "package.json"),
      JSON.stringify({ name: "solid-js", type: "module", main: "index.js" }),
    ),
    writeFile(
      path.join(localSolid, "index.js"),
      "export const createSignal = () => { throw new Error('local Solid used') }\n",
    ),
    writeFile(
      path.join(localOpenTui, "package.json"),
      JSON.stringify({ name: "@opentui/solid", type: "module", main: "index.js" }),
    ),
    writeFile(path.join(localOpenTui, "index.js"), "throw new Error('local OpenTUI used')\n"),
    writeFile(helper, 'export { createSignal, onCleanup } from "solid-js"\n'),
    writeFile(
      source,
      `
import { createSignal, onCleanup } from "./signal"

export const signal = createSignal

export default {
  id: "test.reactive",
  setup(context: any) {
    context.ui.slot("home.footer", () => {
      const [count, setCount] = createSignal(0)
      const timer = setTimeout(() => setCount(1), 10)
      onCleanup(() => clearTimeout(timer))
      return <box><text>count:{count()}</text></box>
    })
  },
}
`,
    ),
  ])

  const plugin = await import(await preparePlugin(new URL(`file://${source}`).href, `${source}?mtime=1`, tmp.path))
  expect(plugin.signal).toBe(createSignal)
  let slot: ((input: object) => JSX.Element) | undefined
  await plugin.default.setup({ ui: { slot: (_name: string, render: typeof slot) => (slot = render) } })
  if (!slot) throw new Error("Plugin did not register its slot")

  const setup = await testRender(() => createComponent(slot!, {}), { width: 20, height: 2 })
  try {
    expect(await setup.waitForFrame((frame) => frame.includes("count:0"))).toContain("count:0")
    expect(await setup.waitForFrame((frame) => frame.includes("count:1"))).toContain("count:1")
  } finally {
    setup.renderer.destroy()
  }
})
