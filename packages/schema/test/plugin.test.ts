import { expect, test } from "bun:test"
import { Schema } from "effect"
import { Plugin } from "../src/plugin.js"

test("plugin inventory distinguishes active code from a failed replacement", () => {
  const info = Schema.decodeUnknownSync(Plugin.Info)({
    id: "example.plugin",
    source: { type: "package", package: "example-plugin@latest" },
    status: "active",
    tui: true,
    revision: "1.0.0",
    generation: "generation-one",
    error: "Replacement setup failed",
  })
  expect(info.status).toBe("active")
  expect(info.revision).toBe("1.0.0")
  expect(info.error).toBe("Replacement setup failed")
  expect(Schema.encodeSync(Plugin.Info)(info)).toEqual(info)
})

test("plugin revision fields remain optional for existing inventories", () => {
  expect(
    Schema.encodeSync(Plugin.Info)({
      id: Plugin.ID.make("example.plugin"),
      source: { type: "local", path: "/plugins/example.ts" },
      status: "active",
      tui: false,
      revision: undefined,
      generation: undefined,
      error: undefined,
    }),
  ).toEqual({
    id: "example.plugin",
    source: { type: "local", path: "/plugins/example.ts" },
    status: "active",
    tui: false,
  })
})

test("package checks omit unknown revisions rather than guessing", () => {
  expect(
    Schema.encodeSync(Plugin.PackageStatus)({
      installed: undefined,
      available: undefined,
      mutable: true,
    }),
  ).toEqual({ mutable: true })
  expect(
    Schema.decodeUnknownSync(Plugin.PackageStatus)({
      installed: "1.0.0",
      available: "1.0.0",
      mutable: false,
    }),
  ).toEqual({ installed: "1.0.0", available: "1.0.0", mutable: false })
})

test("plugin operation errors expose a readable wire message", () => {
  expect(
    Schema.encodeSync(Plugin.OperationError)(new Plugin.OperationError({ message: "Unknown plugin source" })),
  ).toEqual({ _tag: "PluginOperationError", message: "Unknown plugin source" })
})
