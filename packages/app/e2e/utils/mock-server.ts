import type { Page, Route } from "@playwright/test"

export interface MockServerConfig {
  provider: unknown | (() => unknown)
  integrationMethods?: Record<string, unknown[]>
  onConnectKey?: (input: { integrationID: string; body: unknown }) => void
  onInstanceDispose?: () => void
  directory: string
  project: unknown
  sessions: ({ id: string } & Record<string, unknown>)[]
  pageMessages: (sessionId: string, limit: number, before?: string) => { items: unknown[]; cursor?: string }
  vcsDiff?: unknown[]
  messageDelay?: number
  beforeMessagesResponse?: (input: { sessionID: string; before?: string }) => Promise<void>
  onMessages?: (input: { sessionID: string; before?: string; phase: "start" | "end" }) => void
  message?: (sessionID: string, messageID: string) => unknown
  onMessage?: (input: { sessionID: string; messageID: string }) => void
  events?: () => unknown[]
  eventRetry?: number
  todos?: (sessionID: string) => unknown[]
  permissions?: unknown[] | (() => unknown[])
  questions?: unknown[] | (() => unknown[])
  fileList?: (path: string) => unknown | Promise<unknown>
  fileContent?: (path: string) => unknown | Promise<unknown>
  findFiles?: (input: { query: string; dirs?: string; limit?: number }) => unknown
  sessionStatus?: Record<string, unknown> | (() => Record<string, unknown>)
}

export async function mockOpenCodeServer(page: Page, config: MockServerConfig) {
  const cursors = new Map<string, string>()
  let nextCursor = 0
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url())
    const targetPort = process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"
    const appPort = new URL(
      process.env.PLAYWRIGHT_BASE_URL ?? `http://127.0.0.1:${process.env.PLAYWRIGHT_PORT ?? "3000"}`,
    ).port
    if (url.port !== targetPort && url.port !== appPort) return route.fallback()

    const path = url.pathname
    if (path === "/api/event") {
      const events = config.events?.()
      return sse(
        route,
        [{ id: "evt_mock_connected", type: "server.connected", data: {} }, ...(events?.map(currentEvent) ?? [])],
        config.eventRetry,
      )
    }
    if (path === "/api/health") return json(route, { healthy: true, version: "2.0.0", pid: 1 })
    if (path === "/api/reference")
      return json(route, {
        location: {
          directory: config.directory,
          project: { id: (config.project as { id?: string }).id, directory: config.directory },
        },
        data: [],
      })
    if (path === "/api/agent")
      return json(route, {
        location: location(config),
        data: [
          {
            id: "build",
            name: "Build",
            mode: "primary",
            hidden: false,
            request: { settings: {}, headers: {}, body: {} },
            permissions: [],
          },
        ],
      })
    if (path === "/api/command") return json(route, { location: location(config), data: [] })
    if (path === "/api/plugin") return json(route, { location: location(config), data: [] })
    if (path === "/api/mcp") return json(route, { location: location(config), data: [] })
    if (path === "/api/mcp/resource")
      return json(route, { location: location(config), data: { resources: [], templates: [] } })
    const integration = path.match(/^\/api\/integration\/([^/]+)$/)?.[1]
    if (integration && route.request().method() === "GET")
      return json(route, {
        location: location(config),
        data: { id: integration, name: integration, methods: [{ type: "key", label: "API key" }], connections: [] },
      })
    const integrationConnect = path.match(/^\/api\/integration\/([^/]+)\/connect\/key$/)?.[1]
    if (integrationConnect && route.request().method() === "POST") {
      config.onConnectKey?.({ integrationID: integrationConnect, body: route.request().postDataJSON() })
      return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*" } })
    }
    if (/^\/api\/credential\/[^/]+$/.test(path) && route.request().method() === "DELETE")
      return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*" } })
    if (path === "/api/project") return json(route, [config.project])
    if (path === "/api/project/current")
      return json(route, { id: (config.project as { id?: string }).id, directory: config.directory })
    if (path === "/api/location") return json(route, location(config))
    const projectCopy = path.match(/^\/experimental\/project\/([^/]+)\/copy$/)?.[1]
    if (projectCopy && route.request().method() === "POST") {
      const input = route.request().postDataJSON() as { directory: string; name?: string }
      return json(route, { directory: `${input.directory}/${input.name ?? "copy"}` })
    }
    if (projectCopy && route.request().method() === "DELETE")
      return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*" } })
    if (path === "/api/permission/request")
      return json(route, {
        location: location(config),
        data: (typeof config.permissions === "function" ? config.permissions() : (config.permissions ?? [])).map(
          currentPermission,
        ),
      })
    if (path === "/api/question/request")
      return json(route, {
        location: location(config),
        data: typeof config.questions === "function" ? config.questions() : (config.questions ?? []),
      })
    if (path === "/api/vcs")
      return json(route, { location: location(config), data: { branch: "main", defaultBranch: "main" } })
    if (path === "/api/vcs/status") return json(route, { location: location(config), data: [] })
    if (path === "/api/vcs/diff") return json(route, { location: location(config), data: config.vcsDiff ?? [] })
    if (path === "/api/file" && config.fileList)
      return json(route, {
        location: location(config),
        data: await config.fileList(url.searchParams.get("path") ?? ""),
      })
    if (path === "/api/file/read" && config.fileContent) {
      const value = await config.fileContent(url.searchParams.get("path") ?? "")
      const content = value && typeof value === "object" && "content" in value ? String(value.content) : String(value ?? "")
      return route.fulfill({ status: 200, body: content, headers: { "content-type": "application/octet-stream" } })
    }
    if (path === "/api/file/find" && config.findFiles)
      return json(route, {
        location: location(config),
        data: await config.findFiles({
          query: url.searchParams.get("query") ?? "",
          dirs: url.searchParams.get("type") ?? undefined,
          limit: url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : undefined,
        }),
      })
    if (path === "/api/pty/shells") return json(route, { location: location(config), data: [] })
    if (/^\/api\/pty\/[^/]+\/connect-token$/.test(path))
      return json(route, { location: location(config), data: { ticket: "e2e-ticket", expires_in: 60 } })
    if (path === "/api/session") {
      const directory = url.searchParams.get("directory")
      const parentID = url.searchParams.get("parentID")
      const limit = Number(url.searchParams.get("limit") ?? 50)
      const offset = Number(url.searchParams.get("cursor") ?? 0)
      const sessions = config.sessions
        .filter((session) => !directory || session.directory === directory)
        .filter((session) => parentID !== "null" || session.parentID === undefined)
        .filter((session) => {
          const search = url.searchParams.get("search")?.toLowerCase()
          return (
            !search ||
            String(session.title ?? "")
              .toLowerCase()
              .includes(search)
          )
        })
      const ordered = url.searchParams.get("order") === "asc" ? sessions.toReversed() : sessions
      const data = ordered.slice(offset, offset + limit)
      const next = offset + limit < ordered.length ? String(offset + limit) : undefined
      return json(route, {
        data: data.map((session) => currentSession(session, config.directory)),
        cursor: { next },
      })
    }
    if (path === "/api/session/active") {
      const statuses = (config.sessionStatus ?? {}) as Record<string, { type?: string }>
      return json(route, {
        data: Object.fromEntries(
          Object.entries(statuses).flatMap(([id, status]) =>
            status.type === "idle" ? [] : [[id, { type: "running" }]],
          ),
        ),
      })
    }
    if (/^\/api\/session\/[^/]+\/shell$/.test(path) && route.request().method() === "POST") {
      return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*" } })
    }
    if (/^\/api\/session\/[^/]+\/question\/[^/]+\/(reply|reject)$/.test(path) && route.request().method() === "POST") {
      return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*" } })
    }
    if (/^\/api\/session\/[^/]+\/permission\/[^/]+\/reply$/.test(path) && route.request().method() === "POST") {
      return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*" } })
    }
    if (
      /^\/api\/session\/[^/]+\/(archive|rename|interrupt|revert\/clear|revert\/commit)$/.test(path) &&
      route.request().method() === "POST"
    ) {
      return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*" } })
    }
    if (/^\/api\/session\/[^/]+$/.test(path) && route.request().method() === "DELETE") {
      return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*" } })
    }

    const currentSessionMatch = path.match(/^\/api\/session\/([^/]+)$/)
    if (currentSessionMatch) {
      const session = config.sessions.find((item) => item.id === currentSessionMatch[1])
      if (!session) return json(route, { error: "Session not found" }, undefined, 404)
      return json(route, {
        data: currentSession(session, config.directory),
      })
    }

    const currentMessageMatch = path.match(/^\/api\/session\/([^/]+)\/message\/([^/]+)$/)
    if (currentMessageMatch) {
      config.onMessage?.({ sessionID: currentMessageMatch[1]!, messageID: currentMessageMatch[2]! })
      if (config.messageDelay !== undefined) await new Promise((resolve) => setTimeout(resolve, config.messageDelay))
      const message = config.message?.(currentMessageMatch[1]!, currentMessageMatch[2]!)
      if (message === undefined) return json(route, { error: "Message not found" }, undefined, 404)
      return json(route, currentMessage(message))
    }

    const currentMessagesMatch = path.match(/^\/api\/session\/([^/]+)\/message$/)
    if (currentMessagesMatch) {
      const token = url.searchParams.get("cursor") ?? undefined
      const before = token ? cursors.get(token) : undefined
      if (token && !before) return json(route, { error: "Invalid cursor" }, undefined, 400)
      config.onMessages?.({ sessionID: currentMessagesMatch[1], before, phase: "start" })
      await config.beforeMessagesResponse?.({ sessionID: currentMessagesMatch[1]!, before })
      if (config.messageDelay !== undefined) await new Promise((resolve) => setTimeout(resolve, config.messageDelay))
      const pageData = config.pageMessages(currentMessagesMatch[1], Number(url.searchParams.get("limit") ?? 50), before)
      config.onMessages?.({ sessionID: currentMessagesMatch[1], before, phase: "end" })
      const cursor = pageData.cursor ? `cursor_${++nextCursor}` : undefined
      if (cursor) cursors.set(cursor, pageData.cursor!)
      return json(route, {
        data: pageData.items.map(currentMessage).reverse(),
        cursor: { next: cursor },
      })
    }

    if (url.port === targetPort && targetPort !== appPort) return json(route, {})
    return route.fallback()
  })
}

function location(config: MockServerConfig) {
  return {
    directory: config.directory,
    project: { id: (config.project as { id?: string }).id, directory: config.directory },
  }
}

function currentPermission(value: unknown) {
  const permission = value as Record<string, unknown>
  if (permission.action) return permission
  const tool = permission.tool as { messageID?: string; callID?: string } | undefined
  return {
    id: permission.id,
    sessionID: permission.sessionID,
    action: permission.permission,
    resources: permission.patterns ?? [],
    save: permission.always,
    metadata: permission.metadata,
    source:
      tool?.messageID && tool.callID ? { type: "tool", messageID: tool.messageID, callID: tool.callID } : undefined,
  }
}

export function currentSession(session: { id: string } & Record<string, unknown>, fallbackDirectory?: string) {
  const time = session.time && typeof session.time === "object" ? session.time : {}
  return {
    id: session.id,
    parentID: session.parentID,
    projectID: session.projectID ?? "project",
    agent: session.agent ?? "build",
    model: session.model ?? { id: "mock-model", providerID: "mock-provider" },
    cost: session.cost ?? 0,
    tokens: session.tokens ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: {
      created: "created" in time && typeof time.created === "number" ? time.created : 0,
      updated: "updated" in time && typeof time.updated === "number" ? time.updated : 0,
      ...(session.time && typeof session.time === "object" && "archived" in session.time
        ? { archived: session.time.archived }
        : {}),
    },
    title: session.title ?? session.id,
    location: {
      directory: typeof session.directory === "string" ? session.directory : fallbackDirectory,
      ...(typeof session.workspaceID === "string" ? { workspaceID: session.workspaceID } : {}),
    },
    subpath: session.path,
    revert: session.revert,
  }
}

function currentMessage(value: unknown) {
  const item = value as {
    info: Record<string, unknown> & { id: string; role: "user" | "assistant"; time: { created: number } }
    parts: Array<Record<string, unknown> & { type: string }>
  }
  if (item.info.role === "user") {
    return {
      id: item.info.id,
      type: "user",
      time: item.info.time,
      text: item.parts
        .flatMap((part) => (part.type === "text" && typeof part.text === "string" ? [part.text] : []))
        .join("\n"),
    }
  }
  return {
    id: item.info.id,
    type: "assistant",
    time: item.info.time,
    agent: item.info.agent ?? "build",
    model: { id: item.info.modelID ?? "model", providerID: item.info.providerID ?? "provider" },
    cost: item.info.cost,
    tokens: item.info.tokens,
    error: item.info.error,
    content: item.parts.flatMap<unknown>((part) => {
      if (part.type === "text" || part.type === "reasoning") return [{ type: part.type, text: part.text ?? "" }]
      if (part.type !== "tool") return []
      const state = part.state as Record<string, unknown>
      return [
        {
          type: "tool",
          id: part.id,
          name: part.tool,
          time: state.time ?? { created: item.info.time.created },
          state:
            state.status === "pending"
              ? { status: "streaming", input: state.raw ?? JSON.stringify(state.input ?? {}) }
              : state.status === "completed"
                ? {
                    status: "completed",
                    input: state.input ?? {},
                    structured: state.metadata ?? {},
                    content: [{ type: "text", text: state.output ?? "" }],
                  }
                : state.status === "error"
                  ? {
                      status: "error",
                      input: state.input ?? {},
                      structured: state.metadata ?? {},
                      content: [],
                      error: { type: "ToolError", message: state.error ?? "Tool failed" },
                    }
                  : { status: "running", input: state.input ?? {}, structured: state.metadata ?? {}, content: [] },
        },
      ]
    }),
  }
}

function json(route: Route, body: unknown, headers?: Record<string, string>, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    headers: {
      "access-control-allow-origin": "*",
      "access-control-expose-headers": "x-next-cursor",
      ...headers,
    },
    body: JSON.stringify(body ?? null),
  })
}

function sse(route: Route, events?: unknown[], retry?: number) {
  return route.fulfill({
    status: 200,
    contentType: "text/event-stream",
    body: `${retry === undefined ? "" : `retry: ${retry}\n\n`}${events?.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") || ": ok\n\n"}`,
  })
}

function currentEvent(input: unknown) {
  if (!input || typeof input !== "object" || !("payload" in input)) return input
  const envelope = input as { directory?: string; payload?: unknown }
  if (!envelope.payload || typeof envelope.payload !== "object") return input
  const payload = envelope.payload as { id?: string; type?: string; properties?: unknown }
  if (!payload.type) return input
  return {
    id: payload.id ?? `evt_mock_${Date.now()}`,
    created: Date.now(),
    type: payload.type,
    data: payload.properties ?? {},
    location: envelope.directory && envelope.directory !== "global" ? { directory: envelope.directory } : undefined,
  }
}
