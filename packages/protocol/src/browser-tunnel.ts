export * as BrowserTunnelProtocol from "./browser-tunnel.js"

import { BrowserTunnel } from "@opencode-ai/schema/browser-tunnel"
import { BrowserMessageCodec } from "./browser-message-codec.js"

export const Path = "/api/experimental/browser/tunnel"
export const Subprotocol = "opencode.browser.tunnel.v1"
export const MaxFrameBytes = 64 * 1_024
export const MaxHandshakeBytes = 16 * 1_024

const codec = BrowserMessageCodec.make({
  name: "BrowserTunnelProtocol",
  label: "Browser tunnel handshake",
  maxBytes: MaxHandshakeBytes,
  fromClient: BrowserTunnel.FromClient,
  fromServer: BrowserTunnel.FromServer,
})

export const encodeFromClient = codec.encodeFromClient
export const encodeFromServer = codec.encodeFromServer
export const decodeFromClient = codec.decodeFromClient
export const decodeFromServer = codec.decodeFromServer
