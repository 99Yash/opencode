import { chmod, cp, mkdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { getServerTarget } from "./target"

const target = getServerTarget()
const root = path.resolve(import.meta.dirname, "../resources/server-assets")
const nodePtyPackage = `@lydell/node-pty-${target.platform}-${target.arch}`
const parcelWatcherPackage = `@parcel/watcher-${target.platform}-${target.arch}${target.platform === "linux" ? "-glibc" : ""}`
const photonWasm = "@silvia-odwyer/photon-node/photon_rs_bg.wasm"
const nodePtyEntry = fileURLToPath(import.meta.resolve(nodePtyPackage))
const nodePtyRoot = path.resolve(path.dirname(nodePtyEntry), "..")

await rm(root, { recursive: true, force: true })
await mkdir(root, { recursive: true })
await cp(nodePtyRoot, path.join(root, nodePtyPackage), {
  recursive: true,
  filter: (source) => !source.endsWith(".map") && !source.endsWith(".pdb"),
})
await mkdir(path.join(root, parcelWatcherPackage), { recursive: true })
await cp(
  fileURLToPath(import.meta.resolve(parcelWatcherPackage)),
  path.join(root, parcelWatcherPackage, "watcher.node"),
)
await mkdir(path.join(root, path.dirname(photonWasm)), { recursive: true })
await cp(fileURLToPath(import.meta.resolve(photonWasm)), path.join(root, photonWasm))

if (target.platform === "darwin") {
  await chmod(path.join(root, nodePtyPackage, "prebuilds", `darwin-${target.arch}`, "spawn-helper"), 0o755)
}

await writeFile(
  path.join(root, "target.json"),
  `${JSON.stringify({ ...target, nodePtyPackage, parcelWatcherPackage }, null, 2)}\n`,
)
