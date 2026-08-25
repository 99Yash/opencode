export * as BrowserControlProtocol from "./browser-control.js"

import { BrowserControl } from "@opencode-ai/schema/browser-control"
import { BrowserMessageCodec } from "./browser-message-codec.js"

export const Path = "/api/experimental/browser/control"
export const Subprotocol = "opencode.browser.control.v1"
export const MaxMessageBytes = 8 * 1_024 * 1_024

const codec = BrowserMessageCodec.make({
  name: "BrowserControlProtocol",
  label: "Browser control message",
  maxBytes: MaxMessageBytes,
  fromClient: BrowserControl.FromClient,
  fromServer: BrowserControl.FromServer,
})

export const encodeFromClient = codec.encodeFromClient
export const encodeFromServer = codec.encodeFromServer
export const decodeFromClient = codec.decodeFromClient
export const decodeFromServer = codec.decodeFromServer
