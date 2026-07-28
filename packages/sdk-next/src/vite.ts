import { readFile } from "node:fs/promises"
import { createRequire } from "node:module"
import path from "node:path"
import type { Plugin } from "vite"

export function serverVite() {
  const plugins: Plugin[] = [
    {
      name: "opencode:raw-text",
      async load(id) {
        if (!id.endsWith(".md")) return
        return `export default ${JSON.stringify(await readFile(id, "utf8"))}`
      },
    },
    {
      name: "opencode:runtime-require",
      enforce: "pre",
      transform(code, id) {
        if (!id.endsWith("turndown/lib/turndown.es.js")) return
        const transformed = code.replace("    var domino = require('@mixmark-io/domino');", "")
        if (transformed === code) this.error("Failed to rewrite Turndown's Domino require")
        return `import domino from "@mixmark-io/domino"\n${transformed}`
      },
    },
  ]
  return {
    plugins,
    resolve: {
      alias: [
        { find: /^solid-js\/store$/, replacement: "solid-js/store/dist/store.js" },
        { find: /^solid-js$/, replacement: "solid-js/dist/solid.js" },
        {
          find: /^ws$/,
          replacement: path.join(
            path.dirname(createRequire(import.meta.url).resolve("ws/package.json")),
            "wrapper.mjs",
          ),
        },
      ],
      conditions: ["node"],
    },
  }
}
