import path from "path"
import { Global } from "@opencode-ai/util/global"
import { Effect, Layer } from "effect"
import { tmpdir } from "./tmpdir"

export function globalLayer(root: string) {
  const data = path.join(root, "data")
  const cache = path.join(root, "cache")
  return Global.layerWith({
    home: path.join(root, "home"),
    data,
    cache,
    config: path.join(root, "config"),
    state: path.join(root, "state"),
    tmp: path.join(root, "tmp"),
    bin: path.join(cache, "bin"),
    log: path.join(data, "log"),
    repos: path.join(data, "repos"),
  })
}

export const tempGlobalLayer = Layer.unwrap(
  Effect.acquireRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  ).pipe(Effect.map((tmp) => globalLayer(tmp.path))),
)
