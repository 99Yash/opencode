import { Service, VersionMismatchError, type Endpoint, type EnsureOptions } from "@opencode-ai/client/effect/service"
import { ClientError, isUnauthorizedError, OpenCode } from "@opencode-ai/client/promise"
import { OPENCODE_VERSION } from "../version"
import { Effect, Redacted, Result } from "effect"
import { Env } from "../env"
import { ServiceConfig } from "./service-config"
import { Standalone } from "./standalone"

export type Args = {
  readonly server?: string
  readonly standalone?: boolean
  readonly mismatch?: "replace" | "ignore" | "error"
  readonly onStart?: EnsureOptions["onStart"]
  readonly confirmDowngrade?: (serverVersion: string, clientVersion: string) => Effect.Effect<boolean>
}

export type Resolved = {
  readonly endpoint: Endpoint
  readonly service?: ReturnType<typeof managedService>
}

export const resolve = Effect.fn("cli.server-connection.resolve")(function* (args: Args) {
  if (args.server !== undefined && args.standalone)
    return yield* Effect.fail(new Error("--server and --standalone cannot be combined"))
  if (args.server !== undefined) {
    const password = yield* Env.password
    const endpoint = {
      url: args.server,
      auth: password ? { type: "basic" as const, username: "opencode", password: Redacted.value(password) } : undefined,
    } satisfies Endpoint
    const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) })
    const health = yield* Effect.tryPromise({
      try: () => client.health.get({ signal: AbortSignal.timeout(5_000) }),
      catch: (cause) => connectError(endpoint, cause),
    })
    if (health.version !== OPENCODE_VERSION)
      process.stderr.write(
        `Warning: Server at ${endpoint.url} has version ${health.version}; this client is ${OPENCODE_VERSION}. Continuing anyway.\n`,
      )
    return { endpoint } satisfies Resolved
  }
  if (args.standalone) {
    return { endpoint: yield* Standalone.start() } satisfies Resolved
  }

  const mismatch = args.mismatch ?? "ignore"
  const options = yield* ServiceConfig.options({ checkVersion: mismatch !== "ignore" })
  return {
    endpoint: yield* resolveManaged({ ...options, onStart: args.onStart }, mismatch, args.confirmDowngrade),
    service: managedService(options),
  } satisfies Resolved
})

function managedService(options: EnsureOptions) {
  const reconnectOptions = { ...options, version: undefined }
  return {
    reconnect: () => Service.ensure(reconnectOptions),
    restart: () =>
      Effect.gen(function* () {
        yield* Service.stop(options)
        yield* Service.ensure(options)
      }),
  }
}

const resolveManaged = Effect.fnUntraced(function* (
  options: EnsureOptions,
  mismatch: NonNullable<Args["mismatch"]>,
  confirmDowngrade?: Args["confirmDowngrade"],
) {
  if (mismatch === "replace") {
    const result = yield* Effect.result(Service.ensure(options))
    if (Result.isSuccess(result)) return result.success
    return yield* confirmManagedDowngrade(options, result.failure, confirmDowngrade)
  }
  if (mismatch === "ignore") return yield* Service.ensure({ ...options, version: undefined })

  const compatible = yield* Service.discover(options)
  if (compatible !== undefined) return compatible
  const existing = yield* Service.discover({ ...options, version: undefined })
  if (existing !== undefined)
    return yield* Effect.fail(new Error("Background server version does not match this client"))
  return yield* Service.ensure(options)
})

export const confirmManagedDowngrade = Effect.fnUntraced(function* (
  options: EnsureOptions,
  error: unknown,
  confirm?: Args["confirmDowngrade"],
) {
  if (
    !(error instanceof VersionMismatchError) ||
    error.serverVersion === undefined ||
    error.clientVersion === undefined ||
    !Service.canReplaceVersion(error.clientVersion, error.serverVersion) ||
    confirm === undefined
  )
    return yield* Effect.fail(error)
  if (!(yield* confirm(error.serverVersion, error.clientVersion)))
    return yield* Effect.fail(
      new Error(`${error.message}. Run \`opencode2 service restart\` to activate this installed version.`, {
        cause: error,
      }),
    )
  yield* Service.stop(options)
  return yield* Service.ensure(options)
})

function connectError(endpoint: Endpoint, cause: unknown) {
  if (isUnauthorizedError(cause)) {
    return new Error(
      endpoint.auth === undefined
        ? `Server at ${endpoint.url} requires a password; set OPENCODE_PASSWORD`
        : `Server at ${endpoint.url} rejected the password`,
      { cause },
    )
  }
  if (cause instanceof ClientError && cause.reason === "Transport")
    return new Error(`Could not reach server at ${endpoint.url}`, { cause })
  return new Error(`Server at ${endpoint.url} did not provide a compatible V2 health response`, { cause })
}

export * as ServerConnection from "./server-connection"
