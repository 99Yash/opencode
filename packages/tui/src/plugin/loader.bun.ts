import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"
import { isCoreRuntimeModuleSpecifier, runtimeModuleIdForSpecifier } from "@opentui/core/runtime-plugin"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const runtime = new Set([
  "@opentui/solid",
  "@opentui/solid/components",
  "@opentui/solid/jsx-runtime",
  "@opentui/solid/jsx-dev-runtime",
  "solid-js",
  "solid-js/store",
])

export async function preparePlugin(entrypoint: string, version: string, state: string) {
  const source = fileURLToPath(entrypoint)
  if (!source.endsWith(".tsx") && !source.endsWith(".jsx")) return version
  const result = await Bun.build({
    entrypoints: [source],
    target: "bun",
    format: "esm",
    sourcemap: "inline",
    plugins: [
      createSolidTransformPlugin({
        moduleName: runtimeModuleIdForSpecifier("@opentui/solid"),
        resolvePath(specifier) {
          if (!runtime.has(specifier) && !isCoreRuntimeModuleSpecifier(specifier)) return null
          return runtimeModuleIdForSpecifier(specifier)
        },
      }),
    ],
    external: [...runtime, "@opentui/core", "@opentui/core/testing"].flatMap((specifier) => [
      specifier,
      runtimeModuleIdForSpecifier(specifier),
    ]),
  })
  if (!result.success) throw new Error(result.logs.join("\n"))
  const directory = path.join(state, "tui-plugin-cache")
  const output = path.join(directory, `${Bun.hash(version).toString(16)}.mjs`)
  await mkdir(directory, { recursive: true })
  await Bun.write(output, result.outputs[0]!)
  return output
}
