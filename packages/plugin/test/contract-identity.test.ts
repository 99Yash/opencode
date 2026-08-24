import { expect, test } from "bun:test"
import { Agent } from "@opencode-ai/schema/agent"
import { Command } from "@opencode-ai/schema/command"
import { Connection } from "@opencode-ai/schema/connection"
import { Credential } from "@opencode-ai/schema/credential"
import { Integration } from "@opencode-ai/schema/integration"
import { Mcp } from "@opencode-ai/schema/mcp"
import { Model } from "@opencode-ai/schema/model"
import { Provider } from "@opencode-ai/schema/provider"
import { Reference } from "@opencode-ai/schema/reference"
import { Skill } from "@opencode-ai/schema/skill"
import { WebSearch } from "@opencode-ai/schema/websearch"
import { Effect } from "effect"

const Plugin = await import("../src/effect/index")
const EffectPlugin = await import("../src/effect/plugin")
const PromisePlugin = await import("../src/promise/index")
const TuiPlugin = await import("../src/tui/index")

test.each([
  ["effect", Plugin],
  ["promise", PromisePlugin],
])("%s entrypoint exposes its canonical Schema contracts", (_name, entrypoint) => {
  expect(entrypoint.Agent).toBe(Agent)
  expect(entrypoint.Command).toBe(Command)
  expect(entrypoint.Connection).toBe(Connection)
  expect(entrypoint.Credential).toBe(Credential)
  expect(entrypoint.Integration).toBe(Integration)
  expect(entrypoint.Mcp).toBe(Mcp)
  expect(entrypoint.Model).toBe(Model)
  expect(entrypoint.Provider).toBe(Provider)
  expect(entrypoint.Reference).toBe(Reference)
  expect(entrypoint.Skill).toBe(Skill)
  expect(entrypoint.WebSearch).toBe(WebSearch)
  expect(Object.keys(entrypoint).sort()).toEqual([
    "Agent",
    "Command",
    "Connection",
    "Credential",
    "Integration",
    "Mcp",
    "Model",
    "Plugin",
    "Provider",
    "Reference",
    "Skill",
    "WebSearch",
  ])
})

test("effect definitions compile to the Promise plugin ABI", () => {
  const plugin = Plugin.Plugin.define({ id: "effect", effect: () => Effect.void })
  const subpath = EffectPlugin.define({ id: "effect-subpath", effect: () => Effect.void })
  expect(plugin).toHaveProperty("setup")
  expect(plugin).not.toHaveProperty("effect")
  expect(subpath).toHaveProperty("setup")
  expect(subpath).not.toHaveProperty("effect")
})

test("tui entrypoint exposes the plugin definition", () => {
  const plugin = TuiPlugin.Plugin.define({ id: "demo", setup() {} })
  expect(plugin.id).toBe("demo")
})
