import { GatewayProcess } from "@opencode-ai/gateway/process"
import { Service } from "@opencode-ai/client/effect/service"
import { Global } from "@opencode-ai/util/global"
import { Effect, Option } from "effect"
import path from "path"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { OPENCODE_VERSION } from "../../../version"
import { ServerConnection } from "../../../services/server-connection"

export default Runtime.handler(
  Commands.commands.gateway.commands.serve,
  Effect.fnUntraced(function* (input) {
    const password = process.env.OPENCODE_GATEWAY_PASSWORD
    if (!password) return yield* Effect.fail(new Error("OPENCODE_GATEWAY_PASSWORD is required"))
    const global = yield* Global.Service
    const credentialDatabase = process.env.OPENCODE_DB ?? "opencode.db"
    const control = yield* ServerConnection.resolve({ mismatch: "ignore" })
    const gateway = yield* GatewayProcess.start({
      hostname: Option.getOrUndefined(input.hostname),
      port: Option.getOrUndefined(input.port),
      password,
      version: OPENCODE_VERSION,
      root: input.root,
      upstreamPassword: process.env.OPENCODE_GATEWAY_UPSTREAM_PASSWORD ?? password,
      database: Option.getOrUndefined(input.database) ?? path.join(global.data, "gateway.db"),
      credentialDatabase: path.isAbsolute(credentialDatabase)
        ? credentialDatabase
        : path.join(global.data, credentialDatabase),
      controlPlane: {
        url: control.endpoint.url,
        headers: Service.headers(control.endpoint) ?? {},
      },
      modal: {
        app: input.app,
        volume: input.volume,
        environment: Option.getOrUndefined(input.environment),
        image: input.image,
        repository: input.repository,
        branch: input.branch,
      },
    })
    yield* Effect.logInfo("gateway listening", { url: gateway.url.toString() })
    return yield* Effect.never
  }),
)
