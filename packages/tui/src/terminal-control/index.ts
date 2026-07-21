import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { Logging } from "@opencode-ai/core/observability/logging"
import { SimulationActions } from "@opencode-ai/simulation/frontend/actions"
import type { CliRenderer } from "@opentui/core"
import { provideTerminalControlQueries } from "./query-provider.mjs"

export function startTerminalControlQueries(renderer: CliRenderer) {
  const harness = SimulationActions.createHarness(renderer)
  return provideTerminalControlQueries({
    application: { name: "opencode", version: InstallationVersion },
    queries: {
      "ui.snapshot": async () => {
        await harness.renderOnce()
        const snapshot = SimulationActions.snapshot(harness)
        const semanticElements = new Set(snapshot.nodes.map((node) => node.element))
        const semanticIDs = new Set(snapshot.nodes.map((node) => node.id))
        const inferred = SimulationActions.elements(renderer)
          .filter((element) => !semanticElements.has(element.num))
          .map((element) => {
            const id = element.id && !semanticIDs.has(element.id) ? element.id : `renderable-${element.num}`
            semanticIDs.add(id)
            return {
              id,
              role: element.editor ? "textbox" : element.clickable ? "button" : "control",
              label: element.id || undefined,
              element: element.num,
              focused: element.focused || element.editor,
              disabled: false,
            }
          })
        return { ...snapshot, nodes: [...snapshot.nodes, ...inferred] }
      },
      logs: () => Logging.file(),
    },
  })
}
