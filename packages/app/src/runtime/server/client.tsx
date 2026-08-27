import type { OpenCodeEvent } from "@opencode-ai/client/promise"
import { createClientConnection, createPtyClient, type ClientConnectionStatus } from "@opencode-ai/client/solid"
import { createGlobalEmitter } from "@solid-primitives/event-bus"
import { type Accessor, onCleanup } from "solid-js"
import { createApiForServer, type ServerApi, type ServerApiConnection } from "@/runtime/server/api"
import { usePlatform } from "@/runtime/platform/platform"
import { ServerConnection } from "./registry"
import { createRefCountMap } from "@/runtime/server/refcount"
import { ServerScope } from "@/runtime/server/scope"
import { useServer } from "./current"

type OpenCodeEventMap = { [Type in OpenCodeEvent["type"]]: Extract<OpenCodeEvent, { type: Type }> }

export type OpenCodeEventStream = {
  on<Type extends OpenCodeEvent["type"]>(type: Type, handler: (event: OpenCodeEventMap[Type]) => void): VoidFunction
  listen(handler: (event: OpenCodeEvent) => void): VoidFunction
}

type OpenCodeEventSource = OpenCodeEventStream & {
  location(directory: string): OpenCodeEventStream
}

export function createOpenCodeEventSource() {
  const emitter = createGlobalEmitter<OpenCodeEventMap>()

  function stream(directory?: string): OpenCodeEventStream {
    return {
      on(type, handler) {
        return emitter.on(type, (event) => {
          if (directory !== undefined && event.location?.directory !== directory) return
          handler(event)
        })
      },
      listen(handler) {
        return emitter.listen((event) => {
          if (directory !== undefined && event.details.location?.directory !== directory) return
          handler(event.details)
        })
      },
    }
  }

  const event: OpenCodeEventSource = {
    ...stream(),
    location: (directory) => stream(directory),
  }

  onCleanup(() => emitter.clear())

  return {
    event,
    publish(event: OpenCodeEvent) {
      emitter.emit(event.type, event)
    },
  }
}

export type ServerConnectionStatus = ClientConnectionStatus
type ServerSDKBase = {
  server: ServerConnection.Any
  scope: ServerScope
  url: string
  api: ServerApi
  pty: ReturnType<typeof createPtyClient>
  connection: {
    status: Accessor<ServerConnectionStatus>
    attempt: Accessor<number>
    error: Accessor<string | undefined>
  }
  event: OpenCodeEventSource
}

function createServerSdkContextBase(server: ServerConnection.Any, scope: ServerScope): ServerSDKBase {
  const platform = usePlatform()
  const transport = createServerTransport({
    http: server.http,
    fetch: platform.fetch,
    createApi: platform.createServerApi,
  })
  onCleanup(() => void transport.dispose())
  const events = createOpenCodeEventSource()
  const reconnect = server.type === "sidecar" && server.variant === "base" ? server.reconnect : undefined

  const connection = createClientConnection(transport.api, {
    reconnect:
      reconnect || platform.createServerApi
        ? async (signal) => transport.update(reconnect ? await reconnect(signal) : transport.http, signal)
        : undefined,
    flushInterval: 16,
    pageLifecycle: true,
    onEvent(event) {
      events.publish(event)
    },
    log: {
      info(message, data) {
        if (message !== "event stream disconnected") return
        console.info("[global-sdk] event stream disconnected", { url: transport.url, managed: !!reconnect, ...data })
      },
    },
  })

  return {
    server,
    scope,
    get url() {
      return transport.url
    },
    get api() {
      return transport.api
    },
    get pty() {
      return transport.pty
    },
    connection,
    event: events.event,
  }
}

export function createServerTransport(input: {
  http: ServerConnection.HttpBase
  fetch?: typeof globalThis.fetch
  createApi?: (http: ServerConnection.HttpBase) => ServerApiConnection
}): {
  update(http: ServerConnection.HttpBase, signal?: AbortSignal): Promise<ServerApi>
  dispose(): Promise<void>
  readonly http: ServerConnection.HttpBase
  readonly url: string
  readonly api: ServerApi
  readonly pty: ReturnType<typeof createPtyClient>
} {
  const build = (http: ServerConnection.HttpBase) => {
    const connection = input.createApi?.(http) ?? {
      api: createApiForServer({ server: http, fetch: input.fetch }),
      dispose: () => Promise.resolve(),
    }
    return { http, ...connection, pty: createPtyClient(connection.api, { url: http.url }) }
  }
  const state = { current: build(input.http), disposed: false }
  return {
    async update(http: ServerConnection.HttpBase, signal?: AbortSignal) {
      signal?.throwIfAborted()
      if (state.disposed) throw new DOMException(undefined, "AbortError")
      await state.current.dispose()
      signal?.throwIfAborted()
      if (state.disposed) throw new DOMException(undefined, "AbortError")
      state.current = build(http)
      return state.current.api
    },
    dispose() {
      if (state.disposed) return Promise.resolve()
      state.disposed = true
      return state.current.dispose()
    },
    get http() {
      return state.current.http
    },
    get url() {
      return state.current.http.url
    },
    get api() {
      return state.current.api
    },
    get pty() {
      return state.current.pty
    },
  }
}

export type ServerSDK = ServerSDKBase & {
  ensureDirSdkContext: (directory: string) => ReturnType<typeof createDirSdkContext>
}

export function createServerSdkContext(server: ServerConnection.Any, scope: ServerScope): ServerSDK {
  const sdk = createServerSdkContextBase(server, scope)
  return Object.assign(sdk, {
    ensureDirSdkContext: createRefCountMap((dir) => createDirSdkContext(dir, sdk)),
  })
}

export const useServerSDK = () => {
  const server = useServer()
  return server.ctx.sdk
}

export type LocationContext = {
  directory: string
  event: OpenCodeEventStream
}

function createDirSdkContext(directory: string, serverSDK: ServerSDKBase): LocationContext {
  return {
    directory,
    event: serverSDK.event.location(directory),
  }
}
