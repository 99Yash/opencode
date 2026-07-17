import type { Plugin } from "@opencode-ai/plugin/v2/tui"
import type { PluginHost } from "@opencode-ai/tui/plugin/context"
import path from "path"
import { stat } from "fs/promises"
import { fileURLToPath, pathToFileURL } from "url"

export function createPluginHost(resolvePackage: (spec: string) => Promise<string | undefined>): PluginHost {
  return {
    async load(spec, directory) {
      const local = spec.startsWith("file://")
        ? new URL(spec)
        : spec.startsWith("./") || spec.startsWith("../") || path.isAbsolute(spec)
          ? pathToFileURL(path.resolve(directory, spec))
          : undefined
      const entrypoint = local ? await resolveLocal(local) : await resolvePackage(spec)
      if (!entrypoint) return
      const mod: { readonly default?: unknown } = await import(entrypoint)
      if (!isPlugin(mod.default)) throw new Error(`Invalid V2 TUI plugin module: ${spec}`)
      return mod.default
    },
  }
}

async function resolveLocal(url: URL) {
  const info = await stat(url)
  if (info.isFile()) return url.href
  if (!info.isDirectory()) return
  const manifest = Bun.file(path.join(fileURLToPath(url), "package.json"))
  if (await manifest.exists()) {
    const value: unknown = await manifest.json()
    if (typeof value === "object" && value !== null && "exports" in value) {
      const exports = value.exports
      const target =
        typeof exports === "object" && exports !== null && "./tui" in exports ? exports["./tui"] : undefined
      if (typeof target === "string") return pathToFileURL(path.resolve(fileURLToPath(url), target)).href
    }
  }
  return resolve(pathToFileURL(path.join(fileURLToPath(url), "tui")).href)
}

function resolve(specifier: string) {
  try {
    return import.meta.resolve(specifier)
  } catch {
    return undefined
  }
}

function isPlugin(value: unknown): value is Plugin.Definition {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    "setup" in value &&
    typeof value.setup === "function"
  )
}
