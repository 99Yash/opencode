import { expect, test } from "bun:test"
import { Effect } from "effect"
import { OpenApi } from "effect/unstable/httpapi"
import { BrowserControlProtocol } from "../src/browser-control.js"
import { BrowserTunnelProtocol } from "../src/browser-tunnel.js"
import { ClientApi, effectOmitEndpoints, groupNames, promiseOmitEndpoints } from "../src/client.js"

test("browser WebSockets use experimental paths and are omitted from HTTP clients", () => {
  expect(BrowserControlProtocol.Path).toBe("/api/experimental/browser/control")
  expect(BrowserTunnelProtocol.Path).toBe("/api/experimental/browser/tunnel")
  expect(groupNames["server.browser"]).toBe("browser")

  for (const endpoint of ["browser.control.connect", "browser.tunnel.connect"]) {
    expect(promiseOmitEndpoints.has(endpoint)).toBe(true)
    expect(effectOmitEndpoints.has(endpoint)).toBe(true)
  }

  const document = OpenApi.fromApi(ClientApi)
  expect(document.paths).not.toHaveProperty("/api/experimental/browser/control")
  expect(document.paths).not.toHaveProperty("/api/experimental/browser/tunnel")
  expect(document.paths).not.toHaveProperty("/api/browser/control")
  expect(document.paths).not.toHaveProperty("/api/browser/tunnel")
})

test("browser control messages reject unknown properties and invalid UTF-8", async () => {
  expect(
    await Effect.runPromise(
      BrowserControlProtocol.decodeFromServer(
        BrowserControlProtocol.encodeFromServer({ type: "browser.control.open" }),
      ),
    ),
  ).toEqual({ type: "browser.control.open" })
  expect(
    await Effect.runPromise(
      BrowserControlProtocol.decodeFromServer('{"type":"browser.control.open","extra":true}').pipe(Effect.flip),
    ),
  ).toMatchObject({ _tag: "BrowserControlProtocol.MessageError", kind: "invalid" })
  expect(
    await Effect.runPromise(BrowserControlProtocol.decodeFromServer(new Uint8Array([0xff])).pipe(Effect.flip)),
  ).toMatchObject({ _tag: "BrowserControlProtocol.MessageError", kind: "invalid" })
})

test("browser tunnel messages enforce their handshake size and strict decoding", async () => {
  expect(
    await Effect.runPromise(
      BrowserTunnelProtocol.decodeFromServer("x".repeat(BrowserTunnelProtocol.MaxHandshakeBytes + 1)).pipe(Effect.flip),
    ),
  ).toMatchObject({ _tag: "BrowserTunnelProtocol.MessageError", kind: "too_large" })
  expect(
    await Effect.runPromise(
      BrowserTunnelProtocol.decodeFromServer('{"type":"browser.tunnel.opened","extra":true}').pipe(Effect.flip),
    ),
  ).toMatchObject({ _tag: "BrowserTunnelProtocol.MessageError", kind: "invalid" })
  expect(
    await Effect.runPromise(BrowserTunnelProtocol.decodeFromServer(new Uint8Array([0xff])).pipe(Effect.flip)),
  ).toMatchObject({ _tag: "BrowserTunnelProtocol.MessageError", kind: "invalid" })
})
