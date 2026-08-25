import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { BrowserControlProtocol } from "../browser-control.js"
import { BrowserTunnelProtocol } from "../browser-tunnel.js"
import { ConflictError, ServiceUnavailableError } from "../errors.js"

export const BrowserGroup = HttpApiGroup.make("server.browser")
  .add(
    HttpApiEndpoint.get("browser.control.connect", BrowserControlProtocol.Path, {
      success: Schema.Boolean,
      error: ConflictError,
    }),
  )
  .add(
    HttpApiEndpoint.get("browser.tunnel.connect", BrowserTunnelProtocol.Path, {
      success: Schema.Boolean,
      error: ServiceUnavailableError,
    }),
  )
  .annotate(OpenApi.Exclude, true)
