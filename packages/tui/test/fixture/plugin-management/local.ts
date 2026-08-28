import type { Plugin } from "@opencode-ai/plugin/tui"
import { appendFile } from "node:fs/promises"

export default {
  id: "fixture.local",
  async setup(context: Plugin.Context) {
    if (typeof context.options.marker !== "string") throw new Error("Missing fixture lifecycle marker")
    const marker = context.options.marker
    await appendFile(marker, "setup\n")
    return () => appendFile(marker, "cleanup\n")
  },
}
