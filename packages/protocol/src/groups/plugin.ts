import { Location } from "@opencode-ai/schema/location"
import { Plugin } from "@opencode-ai/schema/plugin"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { LocationQuery, locationQueryOpenApi } from "./location.js"

export const PluginGroup = HttpApiGroup.make("server.plugin")
  .add(
    HttpApiEndpoint.get("plugin.list", "/api/plugin", {
      query: LocationQuery,
      success: Location.response(Schema.Array(Plugin.Info)),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.plugin.list",
          summary: "List plugins",
          description: "Retrieve enabled server plugins and their current status.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("plugin.check", "/api/plugin/check", {
      query: LocationQuery,
      payload: Schema.Struct({ target: Schema.String }),
      success: Location.response(Plugin.PackageStatus),
      error: Plugin.OperationError.pipe(HttpApiSchema.status(400)),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.plugin.check",
          summary: "Check plugin updates",
          description: "Check the configured plugin source for a newer compatible revision without activating it.",
        }),
      ),
    HttpApiEndpoint.post("plugin.update", "/api/plugin/update", {
      query: LocationQuery,
      payload: Schema.Struct({ target: Schema.String }),
      success: Location.response(Schema.Array(Plugin.Info)),
      error: Plugin.OperationError.pipe(HttpApiSchema.status(400)),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.plugin.update",
          summary: "Update plugin",
          description: "Update a mutable configured plugin source and activate it after running work finishes.",
        }),
      ),
    HttpApiEndpoint.post("plugin.reload", "/api/plugin/reload", {
      query: LocationQuery,
      payload: Schema.Struct({ target: Schema.String }),
      success: Location.response(Schema.Array(Plugin.Info)),
      error: Plugin.OperationError.pipe(HttpApiSchema.status(400)),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.plugin.reload",
          summary: "Reload plugin",
          description: "Reload a configured plugin source without network access after running work finishes.",
        }),
      ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "plugin",
      description: "Experimental plugin routes.",
    }),
  )
