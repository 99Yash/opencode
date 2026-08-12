import semver from "semver"

/** Connection details for a local OpenCode service. */
export type Endpoint = {
  /** Base URL of the service. */
  readonly url: string
  /** Authentication required by the service, when configured. */
  readonly auth?: {
    /** HTTP authentication scheme. */
    readonly type: "basic"
    /** Basic authentication username. */
    readonly username: string
    /** Basic authentication password. */
    readonly password: string
  }
}

/** Options used to discover the local OpenCode service. */
export type DiscoverOptions = {
  /** Absolute registration file path. Defaults to the XDG state directory. */
  readonly file?: string
  /** Required exact service version or compatibility predicate. */
  readonly version?: string | ((version: string) => boolean)
}

/** Reason ensuring the service requires a new process. */
export type EnsureReason = "missing" | "version-mismatch"

/** Options used to ensure the local OpenCode service is running. */
export type EnsureOptions = DiscoverOptions & {
  /** Service command and arguments. Defaults to `opencode serve --service`. */
  readonly command?: ReadonlyArray<string>
  /** Decide whether a version-mismatched service may be replaced. Defaults to false. */
  readonly canReplace?: (version: string | undefined) => boolean
  /** Called once before spawning a new service process. */
  readonly onStart?: (reason: EnsureReason, previousVersion?: string) => void
}

/** A healthy service exists, but the caller's replacement policy protects it. */
export class VersionMismatchError extends Error {
  override readonly name = "VersionMismatchError"

  constructor(
    readonly clientVersion: string | undefined,
    readonly serverVersion: string | undefined,
  ) {
    super(`Background service ${serverVersion ?? "unknown"} does not match client ${clientVersion ?? "unknown"}`)
  }
}

/** Whether a client version is strictly newer than a service version. */
export function canReplaceVersion(serverVersion: string | undefined, clientVersion: string) {
  if (serverVersion === undefined) return false
  // Compare preview build numbers numerically rather than as semver prerelease strings.
  const server = serverVersion.replace(/-(\d+)(?=(?:\.\d+)?$)/, ".$1")
  const client = clientVersion.replace(/-(\d+)(?=(?:\.\d+)?$)/, ".$1")
  if (!semver.valid(server) || !semver.valid(client)) return false
  return semver.lt(server, client)
}

/** Options used to stop the local OpenCode service. */
export type StopOptions = {
  /** Absolute registration file path. Defaults to the XDG state directory. */
  readonly file?: string
}

/** Contents of the local service registration file. */
export type Info = {
  /** Unique service instance identifier. */
  readonly id?: string
  /** OpenCode version served by the process. */
  readonly version?: string
  /** Base URL advertised by the service. */
  readonly url: string
  /** Operating system process identifier. */
  readonly pid: number
  /** Private service password, when authentication is enabled. */
  readonly password?: string
}
