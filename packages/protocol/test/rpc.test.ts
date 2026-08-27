import { expect, test } from "bun:test"
import { Schema } from "effect"
import { Event } from "@opencode-ai/schema/event"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware, HttpApiSchema } from "effect/unstable/httpapi"
import { RpcSchema } from "effect/unstable/rpc"
import { ClientApi } from "../src/client.js"
import { InvalidRequestError, SessionNotFoundError, UnauthorizedError } from "../src/errors.js"
import { OpenCodeRpc } from "../src/rpc.js"

test("every HTTP operation except the raw PTY sockets has a native RPC", () => {
  const expected = Object.values(ClientApi.groups).flatMap((group) =>
    Object.values(group.endpoints).map((endpoint) => endpoint.identifier),
  )
  expect([...OpenCodeRpc.Group.requests.keys()].sort()).toEqual(
    expected.filter((name) => !OpenCodeRpc.omitEndpoints.has(name)).sort(),
  )
})

test("request envelopes preserve decoded numeric queries and validate required params", () => {
  const list = OpenCodeRpc.fromEndpoint(ClientApi.groups["server.session"].endpoints["session.list"])
  expect(Schema.decodeUnknownSync(list.payloadSchema)({ query: { limit: 10 } })).toEqual({ query: { limit: 10 } })
  expect(() => Schema.decodeUnknownSync(list.payloadSchema)({ query: { limit: "10" } })).toThrow()
  expect(() => Schema.decodeUnknownSync(list.payloadSchema)({ query: { limit: -1 } })).toThrow()
  const get = OpenCodeRpc.fromEndpoint(ClientApi.groups["server.session"].endpoints["session.get"])
  expect(() => Schema.decodeUnknownSync(get.payloadSchema)({})).toThrow()
})

test("SSE streams retain their typed items, without SSE framing", () => {
  const rpc = OpenCodeRpc.fromEndpoint(ClientApi.groups["server.session"].endpoints["session.log"])
  expect(RpcSchema.isStreamSchema(rpc.successSchema)).toBe(true)
  const item = { type: "log.synced" as const, aggregateID: "ses_test", seq: Event.Seq.make(1) }
  expect(Schema.decodeUnknownSync(rpc.successSchema.success)(item)).toEqual(item)
  expect(() => Schema.decodeUnknownSync(rpc.successSchema.success)({ type: "not-an-event" })).toThrow()
  const events = OpenCodeRpc.fromEndpoint(ClientApi.groups["server.event"].endpoints["event.subscribe"])
  expect(
    Schema.decodeUnknownSync(events.successSchema.success)({ id: "evt_connected", type: "server.connected", data: {} }),
  ).toEqual({ id: Event.ID.make("evt_connected"), type: "server.connected", data: {} })
})

test("binary file reads have explicit path and base64 JSON codecs", () => {
  const rpc = OpenCodeRpc.fromEndpoint(ClientApi.groups["server.fs"].endpoints["fs.read"])
  expect(Schema.decodeUnknownSync(rpc.payloadSchema)({ params: { path: "a.bin" }, query: {} })).toEqual({
    params: { path: "a.bin" },
    query: {},
  })
  const value = { content: new Uint8Array([0, 255, 128]), mime: "application/octet-stream" }
  const encoded = Schema.encodeSync(rpc.successSchema)(value)
  expect(encoded).toEqual({ content: "AP+A", mime: "application/octet-stream" })
  expect(Schema.decodeUnknownSync(rpc.successSchema)(JSON.parse(JSON.stringify(encoded)))).toEqual(value)
})

test("NoContent remains void and endpoint plus middleware errors remain typed", () => {
  const rpc = OpenCodeRpc.fromEndpoint(HttpApiEndpoint.delete("test.remove", "/test"))
  expect(Schema.encodeSync(rpc.successSchema)(undefined)).toBeNull()
  expect(Schema.decodeUnknownSync(rpc.successSchema)(null)).toBeUndefined()
  const get = OpenCodeRpc.fromEndpoint(ClientApi.groups["server.session"].endpoints["session.get"])
  for (const error of [
    new InvalidRequestError({ message: "invalid" }),
    new UnauthorizedError({ message: "unauthorized" }),
    new SessionNotFoundError({ sessionID: "ses_test", message: "missing" }),
  ]) {
    expect(Schema.decodeUnknownSync(get.errorSchema)(Schema.encodeSync(get.errorSchema)(error))).toEqual(error)
  }
})

test("makeGroup retains concrete server middleware errors and stream errors", () => {
  class TestError extends Schema.TaggedError<TestError>()("TestError", { message: Schema.String }) {}
  class Middleware extends HttpApiMiddleware.Service<Middleware>()("test/rpc", { error: TestError }) {}
  const api = HttpApi.make("test").add(
    HttpApiGroup.make("test").add(
      HttpApiEndpoint.get("test.stream", "/test", {
        success: HttpApiSchema.StreamSse({ data: Schema.Number, error: TestError }),
      }).middleware(Middleware),
    ),
  )
  const rpc = OpenCodeRpc.makeGroup(api).requests.get("test.stream")!
  const error = new TestError({ message: "failed" })
  expect(Schema.decodeUnknownSync(rpc.errorSchema)(Schema.encodeSync(rpc.errorSchema)(error))).toEqual(error)
  expect(Schema.decodeUnknownSync(rpc.successSchema.error)({ _tag: "TestError", message: "failed" })).toEqual(error)
  expect(Schema.decodeUnknownSync(rpc.successSchema.success)(42)).toBe(42)
})
