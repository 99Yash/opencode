import { plugin } from "bun"

const modules = await Promise.all([
  load("effect", import("effect")),
  load("@opencode-ai/plugin", import("@opencode-ai/plugin")),
  load("@opencode-ai/plugin/app", import("@opencode-ai/plugin/app")),
  load("@opencode-ai/plugin/options", import("@opencode-ai/plugin/options")),
  load("@opencode-ai/plugin/storage", import("@opencode-ai/plugin/storage")),
  load("@opencode-ai/plugin/promise/adapter", import("@opencode-ai/plugin/promise/adapter")),
  load("@opencode-ai/plugin/promise/agent", import("@opencode-ai/plugin/promise/agent")),
  load("@opencode-ai/plugin/promise/aisdk", import("@opencode-ai/plugin/promise/aisdk")),
  load("@opencode-ai/plugin/promise/catalog", import("@opencode-ai/plugin/promise/catalog")),
  load("@opencode-ai/plugin/promise/command", import("@opencode-ai/plugin/promise/command")),
  load("@opencode-ai/plugin/promise/event", import("@opencode-ai/plugin/promise/event")),
  load("@opencode-ai/plugin/promise/index", import("@opencode-ai/plugin/promise/index")),
  load("@opencode-ai/plugin/promise/integration", import("@opencode-ai/plugin/promise/integration")),
  load("@opencode-ai/plugin/promise/mcp", import("@opencode-ai/plugin/promise/mcp")),
  load("@opencode-ai/plugin/promise/plugin", import("@opencode-ai/plugin/promise/plugin")),
  load("@opencode-ai/plugin/promise/reference", import("@opencode-ai/plugin/promise/reference")),
  load("@opencode-ai/plugin/promise/registration", import("@opencode-ai/plugin/promise/registration")),
  load("@opencode-ai/plugin/promise/session", import("@opencode-ai/plugin/promise/session")),
  load("@opencode-ai/plugin/promise/shell", import("@opencode-ai/plugin/promise/shell")),
  load("@opencode-ai/plugin/promise/skill", import("@opencode-ai/plugin/promise/skill")),
  load("@opencode-ai/plugin/promise/storage", import("@opencode-ai/plugin/promise/storage")),
  load("@opencode-ai/plugin/promise/tool", import("@opencode-ai/plugin/promise/tool")),
  load("@opencode-ai/plugin/promise/types", import("@opencode-ai/plugin/promise/types")),
  load("@opencode-ai/plugin/promise/websearch", import("@opencode-ai/plugin/promise/websearch")),
  load("@opencode-ai/plugin/effect", import("@opencode-ai/plugin/effect")),
  load("@opencode-ai/plugin/effect/agent", import("@opencode-ai/plugin/effect/agent")),
  load("@opencode-ai/plugin/effect/aisdk", import("@opencode-ai/plugin/effect/aisdk")),
  load("@opencode-ai/plugin/effect/catalog", import("@opencode-ai/plugin/effect/catalog")),
  load("@opencode-ai/plugin/effect/command", import("@opencode-ai/plugin/effect/command")),
  load("@opencode-ai/plugin/effect/event", import("@opencode-ai/plugin/effect/event")),
  load("@opencode-ai/plugin/effect/index", import("@opencode-ai/plugin/effect/index")),
  load("@opencode-ai/plugin/effect/integration", import("@opencode-ai/plugin/effect/integration")),
  load("@opencode-ai/plugin/effect/mcp", import("@opencode-ai/plugin/effect/mcp")),
  load("@opencode-ai/plugin/effect/plugin", import("@opencode-ai/plugin/effect/plugin")),
  load("@opencode-ai/plugin/effect/reference", import("@opencode-ai/plugin/effect/reference")),
  load("@opencode-ai/plugin/effect/registration", import("@opencode-ai/plugin/effect/registration")),
  load("@opencode-ai/plugin/effect/session", import("@opencode-ai/plugin/effect/session")),
  load("@opencode-ai/plugin/effect/shell", import("@opencode-ai/plugin/effect/shell")),
  load("@opencode-ai/plugin/effect/skill", import("@opencode-ai/plugin/effect/skill")),
  load("@opencode-ai/plugin/effect/storage", import("@opencode-ai/plugin/effect/storage")),
  load("@opencode-ai/plugin/effect/tool", import("@opencode-ai/plugin/effect/tool")),
  load("@opencode-ai/plugin/effect/websearch", import("@opencode-ai/plugin/effect/websearch")),
])

plugin({
  name: "opencode-host-modules",
  setup(build) {
    modules.forEach(([specifier, exports]) => {
      build.module(specifier, () => ({ exports, loader: "object" }))
    })
  },
})

function load(specifier: string, module: Promise<object>) {
  return module.then((exports) => [specifier, Object.fromEntries(Object.entries(exports))] as const)
}
