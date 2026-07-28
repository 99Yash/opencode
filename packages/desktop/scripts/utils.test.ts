import { expect, test } from "bun:test"

import { SIDECAR_BINARIES, getServerTarget } from "./target"
import packageManifest from "../package.json"

test("derives the Windows ARM64 server assets from the release target", () => {
  expect(getServerTarget("aarch64-pc-windows-msvc")).toEqual({
    rustTarget: "aarch64-pc-windows-msvc",
    platform: "win32",
    arch: "arm64",
  })
})

test("derives each packaged server architecture independently of the runner", () => {
  expect(getServerTarget("x86_64-apple-darwin")).toMatchObject({ platform: "darwin", arch: "x64" })
  expect(getServerTarget("aarch64-unknown-linux-gnu")).toMatchObject({ platform: "linux", arch: "arm64" })
})

test("declares every target-native server dependency directly", () => {
  const dependencies = packageManifest.devDependencies
  for (const target of SIDECAR_BINARIES) {
    expect(dependencies[`@lydell/node-pty-${target.platform}-${target.arch}`]).toBeDefined()
    const watcher = `@parcel/watcher-${target.platform}-${target.arch}${target.platform === "linux" ? "-glibc" : ""}`
    expect(dependencies[watcher]).toBeDefined()
  }
  expect(dependencies["@parcel/watcher-darwin-x64"]).toBe("2.5.1")
  expect(dependencies["@silvia-odwyer/photon-node"]).toBe("0.3.4")
})
