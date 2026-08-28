import { afterAll, beforeEach, expect, mock, test } from "bun:test"
import { Effect, Layer, ManagedRuntime } from "effect"
import { RpcClient, RpcGroup, RpcSerialization } from "effect/unstable/rpc"
import { FilesOpenPath } from "../shared/ipc-rpc/files"
import { createDesktopFiles } from "./platform/files"

const sent: unknown[] = []
const protocol = Layer.effect(
  RpcClient.Protocol,
  RpcClient.Protocol.make((write) =>
    Effect.gen(function* () {
      const serialization = yield* RpcSerialization.RpcSerialization
      return {
        codecFor: serialization.codecFor,
        supportsAck: false,
        supportsTransferables: false,
        send: (id, request) => {
          if (request._tag !== "Request") return Effect.void
          sent.push(request.payload)
          return write(id, {
            _tag: "Exit",
            requestId: request.id,
            exit: { _tag: "Success", value: "" },
          })
        },
      }
    }),
  ),
).pipe(Layer.provide(RpcSerialization.layerMsgPack))
const runtime = ManagedRuntime.make(protocol)
beforeEach(() => {
  sent.length = 0
})
afterAll(() => runtime.dispose())

// Replace the Electron transport, but keep the real RPC client's payload validation.
mock.module("./ipc-client", () => ({
  invoke: (tag: string, payload: { path: string; application?: string }) => {
    expect(tag).toBe("FilesOpenPath")
    return runtime.runPromise(
      Effect.gen(function* () {
        const client = yield* RpcClient.make(RpcGroup.make(FilesOpenPath))
        return yield* client.FilesOpenPath(payload)
      }).pipe(Effect.scoped),
    )
  },
  listen: () => () => {},
  send: () => {},
}))
const { api } = await import("./api")
const files = createDesktopFiles(api, "macos", [])
const path = "/Users/test/Documents/opencode_work"

test("project Reveal in Finder sends the path without an application key", async () => {
  await files.openPath(path)
  expect(sent).toEqual([{ path }])
})

test("openPath omits an explicitly undefined application", async () => {
  await api.openPath(path, undefined)
  expect(sent).toEqual([{ path }])
})

test("openPath preserves an explicit application", async () => {
  await files.openPath(path, "Finder")
  expect(sent).toEqual([{ path, application: "Finder" }])
})
