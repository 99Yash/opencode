import { expect, test } from "bun:test"
import { Schema } from "effect"
import { Browser } from "../src/browser.js"
import { BrowserControl } from "../src/browser-control.js"
import { BrowserTunnel } from "../src/browser-tunnel.js"

const state: Browser.State = {
  url: "https://example.com",
  title: "Example",
  loading: false,
  canGoBack: false,
  canGoForward: false,
  generation: 1,
}

test("browser identifiers validate the exact prefixes they generate", () => {
  expect(Browser.LeaseID.create()).toStartWith("brl_")
  expect(BrowserControl.RequestID.create()).toStartWith("brr_")
  expect(() => Schema.decodeUnknownSync(Browser.LeaseID)("brlmissing")).toThrow()
  expect(() => Schema.decodeUnknownSync(BrowserControl.RequestID)("brrmissing")).toThrow()
})

test("browser commands and tunnel targets reject invalid wire values", () => {
  expect(Schema.decodeUnknownSync(Browser.Command)({ type: "click", ref: "e1", generation: 1 })).toEqual({
    type: "click",
    ref: Browser.Ref.make("e1"),
    generation: 1,
  })
  expect(() => Schema.decodeUnknownSync(Browser.Command)({ type: "click", ref: "e0", generation: 1 })).toThrow()
  expect(() => Schema.decodeUnknownSync(BrowserTunnel.Target)({ host: "example.com/path", port: 443 })).toThrow()
  expect(() => Schema.decodeUnknownSync(BrowserTunnel.Target)({ host: "example.com", port: 0 })).toThrow()
})

test("browser screenshots encode binary image data as base64", () => {
  expect(
    Schema.encodeSync(Browser.Result)({
      type: "screenshot",
      state,
      mediaType: "image/png",
      data: new Uint8Array([1, 2, 3]),
      width: 1,
      height: 1,
    }),
  ).toMatchObject({ type: "screenshot", data: "AQID" })
})
