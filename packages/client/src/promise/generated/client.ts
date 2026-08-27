import type {
  HealthGetOutput,
  ServerGetOutput,
  LocationGetInput,
  LocationGetOutput,
  AgentListInput,
  AgentListOutput,
  AgentGetInput,
  AgentGetOutput,
  PluginListInput,
  PluginListOutput,
  SessionListInput,
  SessionListOutput,
  SessionStatsInput,
  SessionStatsOutput,
  SessionCreateInput,
  SessionCreateOutput,
  SessionImportInput,
  SessionImportOutput,
  SessionExportInput,
  SessionExportOutput,
  SessionActiveOutput,
  SessionGetInput,
  SessionGetOutput,
  SessionRemoveInput,
  SessionRemoveOutput,
  SessionForkInput,
  SessionForkOutput,
  SessionSwitchAgentInput,
  SessionSwitchAgentOutput,
  SessionSwitchModelInput,
  SessionSwitchModelOutput,
  SessionRenameInput,
  SessionRenameOutput,
  SessionMoveInput,
  SessionMoveOutput,
  SessionPromptInput,
  SessionPromptOutput,
  SessionCommandInput,
  SessionCommandOutput,
  SessionSkillInput,
  SessionSkillOutput,
  SessionSyntheticInput,
  SessionSyntheticOutput,
  SessionShellInput,
  SessionShellOutput,
  SessionCompactInput,
  SessionCompactOutput,
  SessionWaitInput,
  SessionWaitOutput,
  SessionRevertStageInput,
  SessionRevertStageOutput,
  SessionRevertClearInput,
  SessionRevertClearOutput,
  SessionRevertCommitInput,
  SessionRevertCommitOutput,
  SessionContextInput,
  SessionContextOutput,
  SessionInboxListInput,
  SessionInboxListOutput,
  SessionInboxCancelInput,
  SessionInboxCancelOutput,
  SessionInboxSteerInput,
  SessionInboxSteerOutput,
  SessionInboxQueueInput,
  SessionInboxQueueOutput,
  SessionInstructionsEntryListInput,
  SessionInstructionsEntryListOutput,
  SessionInstructionsEntryPutInput,
  SessionInstructionsEntryPutOutput,
  SessionInstructionsEntryRemoveInput,
  SessionInstructionsEntryRemoveOutput,
  SessionGenerateInput,
  SessionGenerateOutput,
  SessionLogInput,
  SessionLogOutput,
  SessionInterruptInput,
  SessionInterruptOutput,
  SessionBackgroundInput,
  SessionBackgroundOutput,
  SessionMessageInput,
  SessionMessageOutput,
  SessionMessageUpdateInput,
  SessionMessageUpdateOutput,
  SessionEnvironmentInput,
  SessionEnvironmentOutput,
  SessionViewInput,
  SessionViewOutput,
  MessageListInput,
  MessageListOutput,
  ModelListInput,
  ModelListOutput,
  ModelDefaultInput,
  ModelDefaultOutput,
  GenerateTextInput,
  GenerateTextOutput,
  ProviderListInput,
  ProviderListOutput,
  ProviderGetInput,
  ProviderGetOutput,
  IntegrationListInput,
  IntegrationListOutput,
  IntegrationGetInput,
  IntegrationGetOutput,
  IntegrationWellknownAddInput,
  IntegrationWellknownAddOutput,
  IntegrationConnectKeyInput,
  IntegrationConnectKeyOutput,
  IntegrationOauthConnectInput,
  IntegrationOauthConnectOutput,
  IntegrationOauthStatusInput,
  IntegrationOauthStatusOutput,
  IntegrationOauthCompleteInput,
  IntegrationOauthCompleteOutput,
  IntegrationOauthCancelInput,
  IntegrationOauthCancelOutput,
  IntegrationCommandConnectInput,
  IntegrationCommandConnectOutput,
  IntegrationCommandStatusInput,
  IntegrationCommandStatusOutput,
  IntegrationCommandCancelInput,
  IntegrationCommandCancelOutput,
  McpListInput,
  McpListOutput,
  McpAddInput,
  McpAddOutput,
  McpRemoveInput,
  McpRemoveOutput,
  McpConnectInput,
  McpConnectOutput,
  McpDisconnectInput,
  McpDisconnectOutput,
  McpResourceCatalogInput,
  McpResourceCatalogOutput,
  CredentialUpdateInput,
  CredentialUpdateOutput,
  CredentialActivateInput,
  CredentialActivateOutput,
  CredentialRemoveInput,
  CredentialRemoveOutput,
  ProjectListOutput,
  ProjectUpdateInput,
  ProjectUpdateOutput,
  ProjectCurrentInput,
  ProjectCurrentOutput,
  FormRequestListInput,
  FormRequestListOutput,
  FormListInput,
  FormListOutput,
  FormCreateInput,
  FormCreateOutput,
  FormGetInput,
  FormGetOutput,
  FormStateInput,
  FormStateOutput,
  FormReplyInput,
  FormReplyOutput,
  FormCancelInput,
  FormCancelOutput,
  PermissionRequestListInput,
  PermissionRequestListOutput,
  PermissionSavedListInput,
  PermissionSavedListOutput,
  PermissionSavedRemoveInput,
  PermissionSavedRemoveOutput,
  PermissionCreateInput,
  PermissionCreateOutput,
  PermissionListInput,
  PermissionListOutput,
  PermissionGetInput,
  PermissionGetOutput,
  PermissionReplyInput,
  PermissionReplyOutput,
  FileReadInput,
  FileReadOutput,
  FileListInput,
  FileListOutput,
  FileFindInput,
  FileFindOutput,
  CommandListInput,
  CommandListOutput,
  SkillListInput,
  SkillListOutput,
  EventSubscribeOutput,
  PtyListInput,
  PtyListOutput,
  PtyCreateInput,
  PtyCreateOutput,
  PtyGetInput,
  PtyGetOutput,
  PtyUpdateInput,
  PtyUpdateOutput,
  PtyRemoveInput,
  PtyRemoveOutput,
  PtyConnectTokenInput,
  PtyConnectTokenOutput,
  ExperimentalPersistentPtyListInput,
  ExperimentalPersistentPtyListOutput,
  ExperimentalPersistentPtyCreateInput,
  ExperimentalPersistentPtyCreateOutput,
  ExperimentalPersistentPtyShutdownOutput,
  ExperimentalPersistentPtyGetInput,
  ExperimentalPersistentPtyGetOutput,
  ExperimentalPersistentPtyUpdateInput,
  ExperimentalPersistentPtyUpdateOutput,
  ExperimentalPersistentPtySnapshotInput,
  ExperimentalPersistentPtySnapshotOutput,
  ExperimentalPersistentPtyRemoveInput,
  ExperimentalPersistentPtyRemoveOutput,
  ExperimentalPersistentPtyConnectTokenInput,
  ExperimentalPersistentPtyConnectTokenOutput,
  ShellListInput,
  ShellListOutput,
  ShellCreateInput,
  ShellCreateOutput,
  ShellGetInput,
  ShellGetOutput,
  ShellTimeoutInput,
  ShellTimeoutOutput,
  ShellOutputInput,
  ShellOutputOutput,
  ShellRemoveInput,
  ShellRemoveOutput,
  ReferenceListInput,
  ReferenceListOutput,
  WorktreeListInput,
  WorktreeListOutput,
  WorktreeCreateInput,
  WorktreeCreateOutput,
  WorktreeRemoveInput,
  WorktreeRemoveOutput,
  WorktreeRefreshInput,
  WorktreeRefreshOutput,
  WorkspaceCreateInput,
  WorkspaceCreateOutput,
  WorkspaceDestroyInput,
  WorkspaceDestroyOutput,
  VcsGetInput,
  VcsGetOutput,
  VcsStatusInput,
  VcsStatusOutput,
  VcsBranchesInput,
  VcsBranchesOutput,
  VcsDiffInput,
  VcsDiffOutput,
  DebugLocationListOutput,
  DebugLocationEvictInput,
  DebugLocationEvictOutput,
  MigrationV1StatusOutput,
  WebsearchProvidersInput,
  WebsearchProvidersOutput,
  WebsearchQueryInput,
  WebsearchQueryOutput,
  ConfigGetInput,
  ConfigGetOutput,
} from "./types.js"
import { ClientError } from "./client-error.js"

export interface ClientOptions {
  readonly baseUrl: string
  readonly fetch?: typeof globalThis.fetch
  readonly transport?: ClientTransport
  readonly headers?: RequestInit["headers"]
}

export interface RequestOptions {
  readonly signal?: AbortSignal
  readonly headers?: RequestInit["headers"]
}

export interface ClientTransport {
  readonly request: (descriptor: RequestDescriptor, options: RequestOptions) => Promise<unknown>
  readonly stream: (descriptor: RequestDescriptor, options: RequestOptions) => AsyncIterable<unknown>
}

export interface RequestDescriptor {
  readonly operation: string
  readonly params?: Record<string, unknown>
  readonly method: string
  readonly path: string
  readonly query?: Record<string, unknown>
  readonly headers?: Record<string, unknown>
  readonly body?: unknown
  readonly successStatus: number
  readonly declaredStatuses: ReadonlyArray<number>
  readonly empty: boolean
  readonly binary?: true
}

const maxSseEventBytes = 16 * 1024 * 1024

export function make(options: ClientOptions) {
  const fetch = options.fetch ?? globalThis.fetch

  const prepareHeaders = (descriptor: RequestDescriptor, requestOptions?: RequestOptions) => {
    const headers = new Headers(options.headers)
    for (const [key, value] of Object.entries(descriptor.headers ?? {})) {
      if (value !== undefined && value !== null) headers.set(key, String(value))
    }
    for (const [key, value] of new Headers(requestOptions?.headers)) headers.set(key, value)
    return headers
  }

  const prepare = (descriptor: RequestDescriptor, requestOptions?: RequestOptions) => {
    const url = new URL(descriptor.path, options.baseUrl)
    for (const [key, value] of Object.entries(descriptor.query ?? {})) appendQuery(url.searchParams, key, value)
    const headers = prepareHeaders(descriptor, requestOptions)
    if (descriptor.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json")
    return {
      url,
      init: {
        method: descriptor.method,
        signal: requestOptions?.signal,
        headers,
        body: descriptor.body === undefined ? undefined : JSON.stringify(descriptor.body),
      } satisfies RequestInit,
    }
  }

  const execute = async (descriptor: RequestDescriptor, requestOptions?: RequestOptions) => {
    try {
      const prepared = prepare(descriptor, requestOptions)
      return await fetch(prepared.url, prepared.init)
    } catch (cause) {
      throw new ClientError("Transport", { cause })
    }
  }

  const responseError = async (response: Response, descriptor: RequestDescriptor): Promise<never> => {
    if (descriptor.declaredStatuses.includes(response.status)) throw await json(response)
    try {
      await response.body?.cancel()
    } catch {}
    throw new ClientError("UnexpectedStatus", { cause: { status: response.status } })
  }

  const request = async <A>(descriptor: RequestDescriptor, requestOptions?: RequestOptions): Promise<A> => {
    if (options.transport)
      return (await options.transport.request(descriptor, {
        ...requestOptions,
        headers: prepareHeaders(descriptor, requestOptions),
      })) as A
    const response = await execute(descriptor, requestOptions)
    if (response.status !== descriptor.successStatus) return responseError(response, descriptor)
    if (descriptor.binary) return new Uint8Array(await response.arrayBuffer()) as A
    if (descriptor.empty) {
      try {
        await response.body?.cancel()
      } catch {}
      return undefined as A
    }
    return (await json(response)) as A
  }

  const sse = <A>(descriptor: RequestDescriptor, requestOptions?: RequestOptions): AsyncIterable<A> =>
    options.transport
      ? (options.transport.stream(descriptor, {
          ...requestOptions,
          headers: prepareHeaders(descriptor, requestOptions),
        }) as AsyncIterable<A>)
      : {
          async *[Symbol.asyncIterator]() {
            const response = await execute(descriptor, requestOptions)
            if (response.status !== descriptor.successStatus) await responseError(response, descriptor)
            if (!isContentType(response, "text/event-stream")) {
              try {
                await response.body?.cancel()
              } catch {}
              throw new ClientError("UnsupportedContentType")
            }
            if (response.body === null) throw new ClientError("MalformedResponse")
            const reader = response.body.getReader()
            const decoder = new TextDecoder()
            let buffer = ""
            try {
              while (true) {
                let next
                try {
                  next = await reader.read()
                } catch (cause) {
                  throw new ClientError("Transport", { cause })
                }
                buffer += decoder.decode(next.value, { stream: !next.done })
                if (buffer.length > maxSseEventBytes) throw new ClientError("SseEventTooLarge")
                const trailingCarriageReturn = !next.done && buffer.endsWith("\r")
                if (trailingCarriageReturn) buffer = buffer.slice(0, -1)
                buffer = buffer.replaceAll("\r\n", "\n").replaceAll("\r", "\n")
                if (trailingCarriageReturn) buffer += "\r"
                if (next.done && buffer !== "") buffer += "\n\n"
                let boundary = buffer.indexOf("\n\n")
                while (boundary >= 0) {
                  const block = buffer.slice(0, boundary)
                  buffer = buffer.slice(boundary + 2)
                  const data = block
                    .split("\n")
                    .flatMap((line) => (line.startsWith("data:") ? [line.slice(5).trimStart()] : []))
                    .join("\n")
                  if (data !== "") {
                    try {
                      yield JSON.parse(data) as A
                    } catch (cause) {
                      throw new ClientError("MalformedResponse", { cause })
                    }
                  }
                  boundary = buffer.indexOf("\n\n")
                }
                if (next.done) return
              }
            } finally {
              try {
                await reader.cancel()
              } catch {}
              reader.releaseLock()
            }
          },
        }

  return {
    health: {
      get: (requestOptions?: RequestOptions) =>
        request<HealthGetOutput>(
          {
            operation: "health.get",
            method: "GET",
            path: `/api/health`,
            successStatus: 200,
            declaredStatuses: [401, 400],
            empty: false,
          },
          requestOptions,
        ),
    },
    server: {
      get: (requestOptions?: RequestOptions) =>
        request<ServerGetOutput>(
          {
            operation: "server.get",
            method: "GET",
            path: `/api/server`,
            successStatus: 200,
            declaredStatuses: [401, 400],
            empty: false,
          },
          requestOptions,
        ),
    },
    location: {
      get: (input?: LocationGetInput, requestOptions?: RequestOptions) =>
        request<LocationGetOutput>(
          {
            operation: "location.get",
            method: "GET",
            path: `/api/location`,
            query: { location: input?.["location"] },
            successStatus: 200,
            declaredStatuses: [401, 400],
            empty: false,
          },
          requestOptions,
        ),
    },
    agent: {
      list: (input?: AgentListInput, requestOptions?: RequestOptions) =>
        request<AgentListOutput>(
          {
            operation: "agent.list",
            method: "GET",
            path: `/api/agent`,
            query: { location: input?.["location"] },
            successStatus: 200,
            declaredStatuses: [401, 400],
            empty: false,
          },
          requestOptions,
        ),
      get: (input: AgentGetInput, requestOptions?: RequestOptions) =>
        request<AgentGetOutput>(
          {
            operation: "agent.get",
            method: "GET",
            path: `/api/agent/${encodeURIComponent(input.agentID)}`,
            params: { agentID: input["agentID"] },
            query: { location: input["location"] },
            successStatus: 200,
            declaredStatuses: [404, 401, 400],
            empty: false,
          },
          requestOptions,
        ),
    },
    plugin: {
      list: (input?: PluginListInput, requestOptions?: RequestOptions) =>
        request<PluginListOutput>(
          {
            operation: "plugin.list",
            method: "GET",
            path: `/api/plugin`,
            query: { location: input?.["location"] },
            successStatus: 200,
            declaredStatuses: [401, 400],
            empty: false,
          },
          requestOptions,
        ),
    },
    session: {
      list: (input?: SessionListInput, requestOptions?: RequestOptions) =>
        request<SessionListOutput>(
          {
            operation: "session.list",
            method: "GET",
            path: `/api/session`,
            query: {
              workspace: input?.["workspace"],
              limit: input?.["limit"],
              order: input?.["order"],
              search: input?.["search"],
              parentID: input?.["parentID"],
              directory: input?.["directory"],
              project: input?.["project"],
              subpath: input?.["subpath"],
              cursor: input?.["cursor"],
            },
            successStatus: 200,
            declaredStatuses: [400, 401],
            empty: false,
          },
          requestOptions,
        ),
      stats: (input?: SessionStatsInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: SessionStatsOutput }>(
          {
            operation: "session.stats",
            method: "GET",
            path: `/api/session/stats`,
            query: {
              from: input?.["from"],
              to: input?.["to"],
              project: input?.["project"],
              timezone: input?.["timezone"],
              tools: input?.["tools"],
            },
            successStatus: 200,
            declaredStatuses: [400, 401],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      create: (input?: SessionCreateInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: SessionCreateOutput }>(
          {
            operation: "session.create",
            method: "POST",
            path: `/api/session`,
            body: {
              id: input?.["id"],
              title: input?.["title"],
              agent: input?.["agent"],
              model: input?.["model"],
              location: input?.["location"],
            },
            successStatus: 200,
            declaredStatuses: [401, 400],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      import: (input: SessionImportInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: SessionImportOutput }>(
          {
            operation: "session.import",
            method: "POST",
            path: `/api/session/import`,
            body: { info: input["info"], messages: input["messages"], location: input["location"] },
            successStatus: 200,
            declaredStatuses: [409, 401, 400],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      export: (input: SessionExportInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: SessionExportOutput }>(
          {
            operation: "session.export",
            method: "GET",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/export`,
            params: { sessionID: input["sessionID"] },
            query: { sanitize: input["sanitize"] },
            successStatus: 200,
            declaredStatuses: [404, 500, 401, 400],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      active: (requestOptions?: RequestOptions) =>
        request<{ readonly data: SessionActiveOutput }>(
          {
            operation: "session.active",
            method: "GET",
            path: `/api/session/active`,
            successStatus: 200,
            declaredStatuses: [401, 400],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      get: (input: SessionGetInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: SessionGetOutput }>(
          {
            operation: "session.get",
            method: "GET",
            path: `/api/session/${encodeURIComponent(input.sessionID)}`,
            params: { sessionID: input["sessionID"] },
            successStatus: 200,
            declaredStatuses: [404, 401, 400],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      remove: (input: SessionRemoveInput, requestOptions?: RequestOptions) =>
        request<SessionRemoveOutput>(
          {
            operation: "session.remove",
            method: "DELETE",
            path: `/api/session/${encodeURIComponent(input.sessionID)}`,
            params: { sessionID: input["sessionID"] },
            successStatus: 204,
            declaredStatuses: [404, 400, 401],
            empty: true,
          },
          requestOptions,
        ),
      fork: (input: SessionForkInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: SessionForkOutput }>(
          {
            operation: "session.fork",
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/fork`,
            params: { sessionID: input["sessionID"] },
            body: { boundary: input["boundary"] },
            successStatus: 200,
            declaredStatuses: [404, 400, 401],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      switchAgent: (input: SessionSwitchAgentInput, requestOptions?: RequestOptions) =>
        request<SessionSwitchAgentOutput>(
          {
            operation: "session.switchAgent",
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/agent`,
            params: { sessionID: input["sessionID"] },
            body: { agent: input["agent"] },
            successStatus: 204,
            declaredStatuses: [404, 400, 401],
            empty: true,
          },
          requestOptions,
        ),
      switchModel: (input: SessionSwitchModelInput, requestOptions?: RequestOptions) =>
        request<SessionSwitchModelOutput>(
          {
            operation: "session.switchModel",
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/model`,
            params: { sessionID: input["sessionID"] },
            body: { model: input["model"] },
            successStatus: 204,
            declaredStatuses: [404, 400, 401],
            empty: true,
          },
          requestOptions,
        ),
      rename: (input: SessionRenameInput, requestOptions?: RequestOptions) =>
        request<SessionRenameOutput>(
          {
            operation: "session.rename",
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/rename`,
            params: { sessionID: input["sessionID"] },
            body: { title: input["title"] },
            successStatus: 204,
            declaredStatuses: [404, 400, 401],
            empty: true,
          },
          requestOptions,
        ),
      move: (input: SessionMoveInput, requestOptions?: RequestOptions) =>
        request<SessionMoveOutput>(
          {
            operation: "session.move",
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/move`,
            params: { sessionID: input["sessionID"] },
            body: { directory: input["directory"], workspaceID: input["workspaceID"], delivery: input["delivery"] },
            successStatus: 204,
            declaredStatuses: [404, 400, 401],
            empty: true,
          },
          requestOptions,
        ),
      prompt: (input: SessionPromptInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: SessionPromptOutput }>(
          {
            operation: "session.prompt",
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/prompt`,
            params: { sessionID: input["sessionID"] },
            body: {
              id: input["id"],
              text: input["text"],
              files: input["files"],
              agents: input["agents"],
              skills: input["skills"],
              metadata: input["metadata"],
              delivery: input["delivery"],
              resume: input["resume"],
            },
            successStatus: 200,
            declaredStatuses: [409, 400, 404, 401],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      command: (input: SessionCommandInput, requestOptions?: RequestOptions) =>
        request<SessionCommandOutput>(
          {
            operation: "session.command",
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/command`,
            params: { sessionID: input["sessionID"] },
            body: {
              command: input["command"],
              text: input["text"],
              files: input["files"],
              agents: input["agents"],
              skills: input["skills"],
              delivery: input["delivery"],
            },
            successStatus: 204,
            declaredStatuses: [404, 500, 400, 401],
            empty: true,
          },
          requestOptions,
        ),
      skill: (input: SessionSkillInput, requestOptions?: RequestOptions) =>
        request<SessionSkillOutput>(
          {
            operation: "session.skill",
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/skill`,
            params: { sessionID: input["sessionID"] },
            body: { id: input["id"], skill: input["skill"], resume: input["resume"] },
            successStatus: 204,
            declaredStatuses: [404, 400, 401],
            empty: true,
          },
          requestOptions,
        ),
      synthetic: (input: SessionSyntheticInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: SessionSyntheticOutput }>(
          {
            operation: "session.synthetic",
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/synthetic`,
            params: { sessionID: input["sessionID"] },
            body: {
              id: input["id"],
              text: input["text"],
              description: input["description"],
              metadata: input["metadata"],
              delivery: input["delivery"],
              resume: input["resume"],
            },
            successStatus: 200,
            declaredStatuses: [409, 404, 400, 401],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      shell: (input: SessionShellInput, requestOptions?: RequestOptions) =>
        request<SessionShellOutput>(
          {
            operation: "session.shell",
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/shell`,
            params: { sessionID: input["sessionID"] },
            body: { id: input["id"], command: input["command"] },
            successStatus: 204,
            declaredStatuses: [404, 400, 401],
            empty: true,
          },
          requestOptions,
        ),
      compact: (input: SessionCompactInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: SessionCompactOutput }>(
          {
            operation: "session.compact",
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/compact`,
            params: { sessionID: input["sessionID"] },
            body: { id: input["id"], delivery: input["delivery"] },
            successStatus: 200,
            declaredStatuses: [409, 404, 400, 401],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      wait: (input: SessionWaitInput, requestOptions?: RequestOptions) =>
        request<SessionWaitOutput>(
          {
            operation: "session.wait",
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/wait`,
            params: { sessionID: input["sessionID"] },
            successStatus: 204,
            declaredStatuses: [404, 503, 400, 401],
            empty: true,
          },
          requestOptions,
        ),
      revert: {
        stage: (input: SessionRevertStageInput, requestOptions?: RequestOptions) =>
          request<{ readonly data: SessionRevertStageOutput }>(
            {
              operation: "session.revert.stage",
              method: "POST",
              path: `/api/session/${encodeURIComponent(input.sessionID)}/revert/stage`,
              params: { sessionID: input["sessionID"] },
              body: { messageID: input["messageID"], files: input["files"] },
              successStatus: 200,
              declaredStatuses: [404, 409, 500, 400, 401],
              empty: false,
            },
            requestOptions,
          ).then((value) => value.data),
        clear: (input: SessionRevertClearInput, requestOptions?: RequestOptions) =>
          request<SessionRevertClearOutput>(
            {
              operation: "session.revert.clear",
              method: "POST",
              path: `/api/session/${encodeURIComponent(input.sessionID)}/revert/clear`,
              params: { sessionID: input["sessionID"] },
              successStatus: 204,
              declaredStatuses: [404, 409, 500, 400, 401],
              empty: true,
            },
            requestOptions,
          ),
        commit: (input: SessionRevertCommitInput, requestOptions?: RequestOptions) =>
          request<SessionRevertCommitOutput>(
            {
              operation: "session.revert.commit",
              method: "POST",
              path: `/api/session/${encodeURIComponent(input.sessionID)}/revert/commit`,
              params: { sessionID: input["sessionID"] },
              successStatus: 204,
              declaredStatuses: [404, 409, 400, 401],
              empty: true,
            },
            requestOptions,
          ),
      },
      context: (input: SessionContextInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: SessionContextOutput }>(
          {
            operation: "session.context",
            method: "GET",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/context`,
            params: { sessionID: input["sessionID"] },
            successStatus: 200,
            declaredStatuses: [404, 500, 401, 400],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      inbox: {
        list: (input: SessionInboxListInput, requestOptions?: RequestOptions) =>
          request<{ readonly data: SessionInboxListOutput }>(
            {
              operation: "session.inbox.list",
              method: "GET",
              path: `/api/session/${encodeURIComponent(input.sessionID)}/inbox`,
              params: { sessionID: input["sessionID"] },
              successStatus: 200,
              declaredStatuses: [404, 401, 400],
              empty: false,
            },
            requestOptions,
          ).then((value) => value.data),
        cancel: (input: SessionInboxCancelInput, requestOptions?: RequestOptions) =>
          request<SessionInboxCancelOutput>(
            {
              operation: "session.inbox.cancel",
              method: "DELETE",
              path: `/api/session/${encodeURIComponent(input.sessionID)}/inbox/${encodeURIComponent(input.inboxID)}`,
              params: { sessionID: input["sessionID"], inboxID: input["inboxID"] },
              successStatus: 204,
              declaredStatuses: [409, 404, 401, 400],
              empty: true,
            },
            requestOptions,
          ),
        steer: (input: SessionInboxSteerInput, requestOptions?: RequestOptions) =>
          request<SessionInboxSteerOutput>(
            {
              operation: "session.inbox.steer",
              method: "POST",
              path: `/api/session/${encodeURIComponent(input.sessionID)}/inbox/${encodeURIComponent(input.inboxID)}/steer`,
              params: { sessionID: input["sessionID"], inboxID: input["inboxID"] },
              successStatus: 204,
              declaredStatuses: [409, 404, 401, 400],
              empty: true,
            },
            requestOptions,
          ),
        queue: (input: SessionInboxQueueInput, requestOptions?: RequestOptions) =>
          request<SessionInboxQueueOutput>(
            {
              operation: "session.inbox.queue",
              method: "POST",
              path: `/api/session/${encodeURIComponent(input.sessionID)}/inbox/${encodeURIComponent(input.inboxID)}/queue`,
              params: { sessionID: input["sessionID"], inboxID: input["inboxID"] },
              successStatus: 204,
              declaredStatuses: [409, 404, 401, 400],
              empty: true,
            },
            requestOptions,
          ),
      },
      instructions: {
        entry: {
          list: (input: SessionInstructionsEntryListInput, requestOptions?: RequestOptions) =>
            request<{ readonly data: SessionInstructionsEntryListOutput }>(
              {
                operation: "session.instructions.entry.list",
                method: "GET",
                path: `/api/session/${encodeURIComponent(input.sessionID)}/instructions/entries`,
                params: { sessionID: input["sessionID"] },
                successStatus: 200,
                declaredStatuses: [404, 400, 401],
                empty: false,
              },
              requestOptions,
            ).then((value) => value.data),
          put: (input: SessionInstructionsEntryPutInput, requestOptions?: RequestOptions) =>
            request<SessionInstructionsEntryPutOutput>(
              {
                operation: "session.instructions.entry.put",
                method: "PUT",
                path: `/api/session/${encodeURIComponent(input.sessionID)}/instructions/entries/${encodeURIComponent(input.key)}`,
                params: { sessionID: input["sessionID"], key: input["key"] },
                body: { value: input["value"] },
                successStatus: 204,
                declaredStatuses: [404, 413, 400, 401],
                empty: true,
              },
              requestOptions,
            ),
          remove: (input: SessionInstructionsEntryRemoveInput, requestOptions?: RequestOptions) =>
            request<SessionInstructionsEntryRemoveOutput>(
              {
                operation: "session.instructions.entry.remove",
                method: "DELETE",
                path: `/api/session/${encodeURIComponent(input.sessionID)}/instructions/entries/${encodeURIComponent(input.key)}`,
                params: { sessionID: input["sessionID"], key: input["key"] },
                successStatus: 204,
                declaredStatuses: [404, 400, 401],
                empty: true,
              },
              requestOptions,
            ),
        },
      },
      generate: (input: SessionGenerateInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: SessionGenerateOutput }>(
          {
            operation: "session.generate",
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/generate`,
            params: { sessionID: input["sessionID"] },
            body: { prompt: input["prompt"] },
            successStatus: 200,
            declaredStatuses: [404, 503, 400, 401],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      log: (input: SessionLogInput, requestOptions?: RequestOptions): AsyncIterable<SessionLogOutput> =>
        sse<SessionLogOutput>(
          {
            operation: "session.log",
            method: "GET",
            path: `/api/experimental/session/${encodeURIComponent(input.sessionID)}/log`,
            params: { sessionID: input["sessionID"] },
            query: { after: input["after"], follow: input["follow"] },
            successStatus: 200,
            declaredStatuses: [404, 401, 400],
            empty: false,
          },
          requestOptions,
        ),
      interrupt: (input: SessionInterruptInput, requestOptions?: RequestOptions) =>
        request<SessionInterruptOutput>(
          {
            operation: "session.interrupt",
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/interrupt`,
            params: { sessionID: input["sessionID"] },
            query: { continue: input["continue"] },
            successStatus: 200,
            declaredStatuses: [404, 400, 401],
            empty: false,
          },
          requestOptions,
        ),
      background: (input: SessionBackgroundInput, requestOptions?: RequestOptions) =>
        request<SessionBackgroundOutput>(
          {
            operation: "session.background",
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/background`,
            params: { sessionID: input["sessionID"] },
            successStatus: 204,
            declaredStatuses: [404, 400, 401],
            empty: true,
          },
          requestOptions,
        ),
      message: (input: SessionMessageInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: SessionMessageOutput }>(
          {
            operation: "session.message",
            method: "GET",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/message/${encodeURIComponent(input.messageID)}`,
            params: { sessionID: input["sessionID"], messageID: input["messageID"] },
            successStatus: 200,
            declaredStatuses: [404, 401, 400],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      messageUpdate: (input: SessionMessageUpdateInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: SessionMessageUpdateOutput }>(
          {
            operation: "session.messageUpdate",
            method: "PATCH",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/message/${encodeURIComponent(input.messageID)}`,
            params: { sessionID: input["sessionID"], messageID: input["messageID"] },
            body: { content: input["content"] },
            successStatus: 200,
            declaredStatuses: [404, 400, 409, 401],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      environment: (input: SessionEnvironmentInput, requestOptions?: RequestOptions) =>
        request<SessionEnvironmentOutput>(
          {
            operation: "session.environment",
            method: "PUT",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/environment`,
            params: { sessionID: input["sessionID"] },
            body: { variables: input["variables"] },
            successStatus: 204,
            declaredStatuses: [404, 401, 400],
            empty: true,
          },
          requestOptions,
        ),
      view: (input: SessionViewInput, requestOptions?: RequestOptions) =>
        request<SessionViewOutput>(
          {
            operation: "session.view",
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/view`,
            params: { sessionID: input["sessionID"] },
            body: { idle: input["idle"] },
            successStatus: 204,
            declaredStatuses: [404, 401, 400],
            empty: true,
          },
          requestOptions,
        ),
    },
    message: {
      list: (input: MessageListInput, requestOptions?: RequestOptions) =>
        request<MessageListOutput>(
          {
            operation: "session.messages",
            method: "GET",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/message`,
            params: { sessionID: input["sessionID"] },
            query: { limit: input["limit"], order: input["order"], cursor: input["cursor"] },
            successStatus: 200,
            declaredStatuses: [400, 404, 500, 401],
            empty: false,
          },
          requestOptions,
        ),
    },
    model: {
      list: (input?: ModelListInput, requestOptions?: RequestOptions) =>
        request<ModelListOutput>(
          {
            operation: "model.list",
            method: "GET",
            path: `/api/model`,
            query: { location: input?.["location"] },
            successStatus: 200,
            declaredStatuses: [503, 401, 400],
            empty: false,
          },
          requestOptions,
        ),
      default: (input?: ModelDefaultInput, requestOptions?: RequestOptions) =>
        request<ModelDefaultOutput>(
          {
            operation: "model.default",
            method: "GET",
            path: `/api/model/default`,
            query: { location: input?.["location"] },
            successStatus: 200,
            declaredStatuses: [503, 401, 400],
            empty: false,
          },
          requestOptions,
        ),
    },
    generate: {
      text: (input: GenerateTextInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: GenerateTextOutput }>(
          {
            operation: "generate.text",
            method: "POST",
            path: `/api/generate`,
            body: { prompt: input["prompt"], model: input["model"] },
            successStatus: 200,
            declaredStatuses: [400, 503, 401],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
    },
    provider: {
      list: (input?: ProviderListInput, requestOptions?: RequestOptions) =>
        request<ProviderListOutput>(
          {
            operation: "provider.list",
            method: "GET",
            path: `/api/provider`,
            query: { location: input?.["location"] },
            successStatus: 200,
            declaredStatuses: [503, 401, 400],
            empty: false,
          },
          requestOptions,
        ),
      get: (input: ProviderGetInput, requestOptions?: RequestOptions) =>
        request<ProviderGetOutput>(
          {
            operation: "provider.get",
            method: "GET",
            path: `/api/provider/${encodeURIComponent(input.providerID)}`,
            params: { providerID: input["providerID"] },
            query: { location: input["location"] },
            successStatus: 200,
            declaredStatuses: [404, 503, 401, 400],
            empty: false,
          },
          requestOptions,
        ),
    },
    integration: {
      list: (input?: IntegrationListInput, requestOptions?: RequestOptions) =>
        request<IntegrationListOutput>(
          {
            operation: "integration.list",
            method: "GET",
            path: `/api/integration`,
            query: { location: input?.["location"] },
            successStatus: 200,
            declaredStatuses: [401, 400],
            empty: false,
          },
          requestOptions,
        ),
      get: (input: IntegrationGetInput, requestOptions?: RequestOptions) =>
        request<IntegrationGetOutput>(
          {
            operation: "integration.get",
            method: "GET",
            path: `/api/integration/${encodeURIComponent(input.integrationID)}`,
            params: { integrationID: input["integrationID"] },
            query: { location: input["location"] },
            successStatus: 200,
            declaredStatuses: [401, 400],
            empty: false,
          },
          requestOptions,
        ),
      wellknown: {
        add: (input: IntegrationWellknownAddInput, requestOptions?: RequestOptions) =>
          request<IntegrationWellknownAddOutput>(
            {
              operation: "integration.wellknown.add",
              method: "POST",
              path: `/api/experimental/integration/wellknown`,
              query: { location: input["location"] },
              body: { url: input["url"] },
              successStatus: 204,
              declaredStatuses: [400, 401],
              empty: true,
            },
            requestOptions,
          ),
      },
      connect: {
        key: (input: IntegrationConnectKeyInput, requestOptions?: RequestOptions) =>
          request<IntegrationConnectKeyOutput>(
            {
              operation: "integration.connect.key",
              method: "POST",
              path: `/api/integration/${encodeURIComponent(input.integrationID)}/connect/key`,
              params: { integrationID: input["integrationID"] },
              query: { location: input["location"] },
              body: { key: input["key"], answer: input["answer"], label: input["label"] },
              successStatus: 204,
              declaredStatuses: [400, 401],
              empty: true,
            },
            requestOptions,
          ),
      },
      oauth: {
        connect: (input: IntegrationOauthConnectInput, requestOptions?: RequestOptions) =>
          request<IntegrationOauthConnectOutput>(
            {
              operation: "integration.oauth.connect",
              method: "POST",
              path: `/api/integration/${encodeURIComponent(input.integrationID)}/connect/oauth`,
              params: { integrationID: input["integrationID"] },
              query: { location: input["location"] },
              body: { methodID: input["methodID"], answer: input["answer"], label: input["label"] },
              successStatus: 200,
              declaredStatuses: [400, 401],
              empty: false,
            },
            requestOptions,
          ),
        status: (input: IntegrationOauthStatusInput, requestOptions?: RequestOptions) =>
          request<IntegrationOauthStatusOutput>(
            {
              operation: "integration.oauth.status",
              method: "GET",
              path: `/api/integration/${encodeURIComponent(input.integrationID)}/connect/oauth/${encodeURIComponent(input.attemptID)}`,
              params: { integrationID: input["integrationID"], attemptID: input["attemptID"] },
              query: { location: input["location"] },
              successStatus: 200,
              declaredStatuses: [401, 400],
              empty: false,
            },
            requestOptions,
          ),
        complete: (input: IntegrationOauthCompleteInput, requestOptions?: RequestOptions) =>
          request<IntegrationOauthCompleteOutput>(
            {
              operation: "integration.oauth.complete",
              method: "POST",
              path: `/api/integration/${encodeURIComponent(input.integrationID)}/connect/oauth/${encodeURIComponent(input.attemptID)}/complete`,
              params: { integrationID: input["integrationID"], attemptID: input["attemptID"] },
              query: { location: input["location"] },
              body: { code: input["code"] },
              successStatus: 204,
              declaredStatuses: [400, 401],
              empty: true,
            },
            requestOptions,
          ),
        cancel: (input: IntegrationOauthCancelInput, requestOptions?: RequestOptions) =>
          request<IntegrationOauthCancelOutput>(
            {
              operation: "integration.oauth.cancel",
              method: "DELETE",
              path: `/api/integration/${encodeURIComponent(input.integrationID)}/connect/oauth/${encodeURIComponent(input.attemptID)}`,
              params: { integrationID: input["integrationID"], attemptID: input["attemptID"] },
              query: { location: input["location"] },
              successStatus: 204,
              declaredStatuses: [401, 400],
              empty: true,
            },
            requestOptions,
          ),
      },
      command: {
        connect: (input: IntegrationCommandConnectInput, requestOptions?: RequestOptions) =>
          request<IntegrationCommandConnectOutput>(
            {
              operation: "integration.command.connect",
              method: "POST",
              path: `/api/integration/${encodeURIComponent(input.integrationID)}/connect/command`,
              params: { integrationID: input["integrationID"] },
              query: { location: input["location"] },
              body: { methodID: input["methodID"], label: input["label"] },
              successStatus: 200,
              declaredStatuses: [400, 401],
              empty: false,
            },
            requestOptions,
          ),
        status: (input: IntegrationCommandStatusInput, requestOptions?: RequestOptions) =>
          request<IntegrationCommandStatusOutput>(
            {
              operation: "integration.command.status",
              method: "GET",
              path: `/api/integration/${encodeURIComponent(input.integrationID)}/connect/command/${encodeURIComponent(input.attemptID)}`,
              params: { integrationID: input["integrationID"], attemptID: input["attemptID"] },
              query: { location: input["location"] },
              successStatus: 200,
              declaredStatuses: [401, 400],
              empty: false,
            },
            requestOptions,
          ),
        cancel: (input: IntegrationCommandCancelInput, requestOptions?: RequestOptions) =>
          request<IntegrationCommandCancelOutput>(
            {
              operation: "integration.command.cancel",
              method: "DELETE",
              path: `/api/integration/${encodeURIComponent(input.integrationID)}/connect/command/${encodeURIComponent(input.attemptID)}`,
              params: { integrationID: input["integrationID"], attemptID: input["attemptID"] },
              query: { location: input["location"] },
              successStatus: 204,
              declaredStatuses: [401, 400],
              empty: true,
            },
            requestOptions,
          ),
      },
    },
    mcp: {
      list: (input?: McpListInput, requestOptions?: RequestOptions) =>
        request<McpListOutput>(
          {
            operation: "mcp.list",
            method: "GET",
            path: `/api/mcp`,
            query: { location: input?.["location"] },
            successStatus: 200,
            declaredStatuses: [401, 400],
            empty: false,
          },
          requestOptions,
        ),
      add: (input: McpAddInput, requestOptions?: RequestOptions) =>
        request<McpAddOutput>(
          {
            operation: "mcp.add",
            method: "PUT",
            path: `/api/mcp/${encodeURIComponent(input.server)}`,
            params: { server: input["server"] },
            query: { location: input["location"] },
            body: { config: input["config"] },
            successStatus: 204,
            declaredStatuses: [401, 400],
            empty: true,
          },
          requestOptions,
        ),
      remove: (input: McpRemoveInput, requestOptions?: RequestOptions) =>
        request<McpRemoveOutput>(
          {
            operation: "mcp.remove",
            method: "DELETE",
            path: `/api/mcp/${encodeURIComponent(input.server)}`,
            params: { server: input["server"] },
            query: { location: input["location"] },
            successStatus: 204,
            declaredStatuses: [404, 401, 400],
            empty: true,
          },
          requestOptions,
        ),
      connect: (input: McpConnectInput, requestOptions?: RequestOptions) =>
        request<McpConnectOutput>(
          {
            operation: "mcp.connect",
            method: "POST",
            path: `/api/mcp/${encodeURIComponent(input.server)}/connect`,
            params: { server: input["server"] },
            query: { location: input["location"] },
            successStatus: 204,
            declaredStatuses: [404, 401, 400],
            empty: true,
          },
          requestOptions,
        ),
      disconnect: (input: McpDisconnectInput, requestOptions?: RequestOptions) =>
        request<McpDisconnectOutput>(
          {
            operation: "mcp.disconnect",
            method: "POST",
            path: `/api/mcp/${encodeURIComponent(input.server)}/disconnect`,
            params: { server: input["server"] },
            query: { location: input["location"] },
            successStatus: 204,
            declaredStatuses: [404, 401, 400],
            empty: true,
          },
          requestOptions,
        ),
      resource: {
        catalog: (input?: McpResourceCatalogInput, requestOptions?: RequestOptions) =>
          request<McpResourceCatalogOutput>(
            {
              operation: "mcp.resource.catalog",
              method: "GET",
              path: `/api/mcp/resource`,
              query: { location: input?.["location"] },
              successStatus: 200,
              declaredStatuses: [401, 400],
              empty: false,
            },
            requestOptions,
          ),
      },
    },
    credential: {
      update: (input: CredentialUpdateInput, requestOptions?: RequestOptions) =>
        request<CredentialUpdateOutput>(
          {
            operation: "credential.update",
            method: "PATCH",
            path: `/api/credential/${encodeURIComponent(input.credentialID)}`,
            params: { credentialID: input["credentialID"] },
            query: { location: input["location"] },
            body: { label: input["label"] },
            successStatus: 204,
            declaredStatuses: [401, 400],
            empty: true,
          },
          requestOptions,
        ),
      activate: (input: CredentialActivateInput, requestOptions?: RequestOptions) =>
        request<CredentialActivateOutput>(
          {
            operation: "credential.activate",
            method: "POST",
            path: `/api/credential/${encodeURIComponent(input.credentialID)}/activate`,
            params: { credentialID: input["credentialID"] },
            query: { location: input["location"] },
            successStatus: 204,
            declaredStatuses: [401, 400],
            empty: true,
          },
          requestOptions,
        ),
      remove: (input: CredentialRemoveInput, requestOptions?: RequestOptions) =>
        request<CredentialRemoveOutput>(
          {
            operation: "credential.remove",
            method: "DELETE",
            path: `/api/credential/${encodeURIComponent(input.credentialID)}`,
            params: { credentialID: input["credentialID"] },
            query: { location: input["location"] },
            successStatus: 204,
            declaredStatuses: [401, 400],
            empty: true,
          },
          requestOptions,
        ),
    },
    project: {
      list: (requestOptions?: RequestOptions) =>
        request<ProjectListOutput>(
          {
            operation: "project.list",
            method: "GET",
            path: `/api/project`,
            successStatus: 200,
            declaredStatuses: [401, 400],
            empty: false,
          },
          requestOptions,
        ),
      update: (input: ProjectUpdateInput, requestOptions?: RequestOptions) =>
        request<ProjectUpdateOutput>(
          {
            operation: "project.update",
            method: "PATCH",
            path: `/api/project/${encodeURIComponent(input.projectID)}`,
            params: { projectID: input["projectID"] },
            body: { name: input["name"], icon: input["icon"], commands: input["commands"] },
            successStatus: 200,
            declaredStatuses: [404, 401, 400],
            empty: false,
          },
          requestOptions,
        ),
      current: (input?: ProjectCurrentInput, requestOptions?: RequestOptions) =>
        request<ProjectCurrentOutput>(
          {
            operation: "project.current",
            method: "GET",
            path: `/api/project/current`,
            query: { location: input?.["location"] },
            successStatus: 200,
            declaredStatuses: [401, 400],
            empty: false,
          },
          requestOptions,
        ),
    },
    form: {
      request: {
        list: (input?: FormRequestListInput, requestOptions?: RequestOptions) =>
          request<FormRequestListOutput>(
            {
              operation: "form.request.list",
              method: "GET",
              path: `/api/form/request`,
              query: { location: input?.["location"] },
              successStatus: 200,
              declaredStatuses: [401, 400],
              empty: false,
            },
            requestOptions,
          ),
      },
      list: (input: FormListInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: FormListOutput }>(
          {
            operation: "session.form.list",
            method: "GET",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/form`,
            params: { sessionID: input["sessionID"] },
            successStatus: 200,
            declaredStatuses: [404, 400, 401],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      create: (input: FormCreateInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: FormCreateOutput }>(
          {
            operation: "session.form.create",
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/form`,
            params: { sessionID: input["sessionID"] },
            body: { id: input["id"], title: input["title"], metadata: input["metadata"], fields: input["fields"] },
            successStatus: 200,
            declaredStatuses: [404, 409, 400, 401],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      get: (input: FormGetInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: FormGetOutput }>(
          {
            operation: "session.form.get",
            method: "GET",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/form/${encodeURIComponent(input.formID)}`,
            params: { sessionID: input["sessionID"], formID: input["formID"] },
            successStatus: 200,
            declaredStatuses: [404, 400, 401],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      state: (input: FormStateInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: FormStateOutput }>(
          {
            operation: "session.form.state",
            method: "GET",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/form/${encodeURIComponent(input.formID)}/state`,
            params: { sessionID: input["sessionID"], formID: input["formID"] },
            successStatus: 200,
            declaredStatuses: [404, 400, 401],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      reply: (input: FormReplyInput, requestOptions?: RequestOptions) =>
        request<FormReplyOutput>(
          {
            operation: "session.form.reply",
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/form/${encodeURIComponent(input.formID)}/reply`,
            params: { sessionID: input["sessionID"], formID: input["formID"] },
            body: { answer: input["answer"] },
            successStatus: 204,
            declaredStatuses: [404, 409, 400, 401],
            empty: true,
          },
          requestOptions,
        ),
      cancel: (input: FormCancelInput, requestOptions?: RequestOptions) =>
        request<FormCancelOutput>(
          {
            operation: "session.form.cancel",
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/form/${encodeURIComponent(input.formID)}/cancel`,
            params: { sessionID: input["sessionID"], formID: input["formID"] },
            successStatus: 204,
            declaredStatuses: [404, 409, 400, 401],
            empty: true,
          },
          requestOptions,
        ),
    },
    permission: {
      request: {
        list: (input?: PermissionRequestListInput, requestOptions?: RequestOptions) =>
          request<PermissionRequestListOutput>(
            {
              operation: "permission.request.list",
              method: "GET",
              path: `/api/permission/request`,
              query: { location: input?.["location"] },
              successStatus: 200,
              declaredStatuses: [401, 400],
              empty: false,
            },
            requestOptions,
          ),
      },
      saved: {
        list: (input?: PermissionSavedListInput, requestOptions?: RequestOptions) =>
          request<{ readonly data: PermissionSavedListOutput }>(
            {
              operation: "permission.saved.list",
              method: "GET",
              path: `/api/permission/saved`,
              query: { projectID: input?.["projectID"] },
              successStatus: 200,
              declaredStatuses: [401, 400],
              empty: false,
            },
            requestOptions,
          ).then((value) => value.data),
        remove: (input: PermissionSavedRemoveInput, requestOptions?: RequestOptions) =>
          request<PermissionSavedRemoveOutput>(
            {
              operation: "permission.saved.remove",
              method: "DELETE",
              path: `/api/permission/saved/${encodeURIComponent(input.id)}`,
              params: { id: input["id"] },
              successStatus: 204,
              declaredStatuses: [401, 400],
              empty: true,
            },
            requestOptions,
          ),
      },
      create: (input: PermissionCreateInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: PermissionCreateOutput }>(
          {
            operation: "session.permission.create",
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/permission`,
            params: { sessionID: input["sessionID"] },
            body: {
              id: input["id"],
              action: input["action"],
              resources: input["resources"],
              save: input["save"],
              metadata: input["metadata"],
              source: input["source"],
              agent: input["agent"],
            },
            successStatus: 200,
            declaredStatuses: [404, 400, 401],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      list: (input: PermissionListInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: PermissionListOutput }>(
          {
            operation: "session.permission.list",
            method: "GET",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/permission`,
            params: { sessionID: input["sessionID"] },
            successStatus: 200,
            declaredStatuses: [404, 400, 401],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      get: (input: PermissionGetInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: PermissionGetOutput }>(
          {
            operation: "session.permission.get",
            method: "GET",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/permission/${encodeURIComponent(input.requestID)}`,
            params: { sessionID: input["sessionID"], requestID: input["requestID"] },
            successStatus: 200,
            declaredStatuses: [404, 400, 401],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      reply: (input: PermissionReplyInput, requestOptions?: RequestOptions) =>
        request<PermissionReplyOutput>(
          {
            operation: "session.permission.reply",
            method: "POST",
            path: `/api/session/${encodeURIComponent(input.sessionID)}/permission/${encodeURIComponent(input.requestID)}/reply`,
            params: { sessionID: input["sessionID"], requestID: input["requestID"] },
            body: { reply: input["reply"], message: input["message"] },
            successStatus: 204,
            declaredStatuses: [404, 400, 401],
            empty: true,
          },
          requestOptions,
        ),
    },
    file: {
      read: (input: FileReadInput, requestOptions?: RequestOptions) =>
        request<FileReadOutput>(
          {
            operation: "fs.read",
            method: "GET",
            path: `/api/fs/read/${encodePath(input.path)}`,
            params: { path: input["path"] },
            query: { location: input["location"] },
            successStatus: 200,
            declaredStatuses: [401, 400],
            empty: false,
            binary: true,
          },
          requestOptions,
        ),
      list: (input?: FileListInput, requestOptions?: RequestOptions) =>
        request<FileListOutput>(
          {
            operation: "fs.list",
            method: "GET",
            path: `/api/fs/list`,
            query: { location: input?.["location"], path: input?.["path"] },
            successStatus: 200,
            declaredStatuses: [401, 400],
            empty: false,
          },
          requestOptions,
        ),
      find: (input: FileFindInput, requestOptions?: RequestOptions) =>
        request<FileFindOutput>(
          {
            operation: "fs.find",
            method: "GET",
            path: `/api/fs/find`,
            query: { location: input["location"], query: input["query"], type: input["type"], limit: input["limit"] },
            successStatus: 200,
            declaredStatuses: [401, 400],
            empty: false,
          },
          requestOptions,
        ),
    },
    command: {
      list: (input?: CommandListInput, requestOptions?: RequestOptions) =>
        request<CommandListOutput>(
          {
            operation: "command.list",
            method: "GET",
            path: `/api/command`,
            query: { location: input?.["location"] },
            successStatus: 200,
            declaredStatuses: [401, 400],
            empty: false,
          },
          requestOptions,
        ),
    },
    skill: {
      list: (input?: SkillListInput, requestOptions?: RequestOptions) =>
        request<SkillListOutput>(
          {
            operation: "skill.list",
            method: "GET",
            path: `/api/skill`,
            query: { location: input?.["location"] },
            successStatus: 200,
            declaredStatuses: [401, 400],
            empty: false,
          },
          requestOptions,
        ),
    },
    event: {
      subscribe: (requestOptions?: RequestOptions): AsyncIterable<EventSubscribeOutput> =>
        sse<EventSubscribeOutput>(
          {
            operation: "event.subscribe",
            method: "GET",
            path: `/api/event`,
            successStatus: 200,
            declaredStatuses: [401, 400],
            empty: false,
          },
          requestOptions,
        ),
    },
    pty: {
      list: (input?: PtyListInput, requestOptions?: RequestOptions) =>
        request<PtyListOutput>(
          {
            operation: "pty.list",
            method: "GET",
            path: `/api/pty`,
            query: { location: input?.["location"] },
            successStatus: 200,
            declaredStatuses: [401, 400],
            empty: false,
          },
          requestOptions,
        ),
      create: (input?: PtyCreateInput, requestOptions?: RequestOptions) =>
        request<PtyCreateOutput>(
          {
            operation: "pty.create",
            method: "POST",
            path: `/api/pty`,
            query: { location: input?.["location"] },
            body: {
              command: input?.["command"],
              args: input?.["args"],
              cwd: input?.["cwd"],
              title: input?.["title"],
              env: input?.["env"],
            },
            successStatus: 200,
            declaredStatuses: [401, 400],
            empty: false,
          },
          requestOptions,
        ),
      get: (input: PtyGetInput, requestOptions?: RequestOptions) =>
        request<PtyGetOutput>(
          {
            operation: "pty.get",
            method: "GET",
            path: `/api/pty/${encodeURIComponent(input.ptyID)}`,
            params: { ptyID: input["ptyID"] },
            query: { location: input["location"] },
            successStatus: 200,
            declaredStatuses: [404, 401, 400],
            empty: false,
          },
          requestOptions,
        ),
      update: (input: PtyUpdateInput, requestOptions?: RequestOptions) =>
        request<PtyUpdateOutput>(
          {
            operation: "pty.update",
            method: "PUT",
            path: `/api/pty/${encodeURIComponent(input.ptyID)}`,
            params: { ptyID: input["ptyID"] },
            query: { location: input["location"] },
            body: { title: input["title"], size: input["size"] },
            successStatus: 200,
            declaredStatuses: [404, 401, 400],
            empty: false,
          },
          requestOptions,
        ),
      remove: (input: PtyRemoveInput, requestOptions?: RequestOptions) =>
        request<PtyRemoveOutput>(
          {
            operation: "pty.remove",
            method: "DELETE",
            path: `/api/pty/${encodeURIComponent(input.ptyID)}`,
            params: { ptyID: input["ptyID"] },
            query: { location: input["location"] },
            successStatus: 204,
            declaredStatuses: [404, 401, 400],
            empty: true,
          },
          requestOptions,
        ),
      connect: {
        token: (input: PtyConnectTokenInput, requestOptions?: RequestOptions) =>
          request<PtyConnectTokenOutput>(
            {
              operation: "pty.connectToken",
              method: "POST",
              path: `/api/pty/${encodeURIComponent(input.ptyID)}/connect-token`,
              params: { ptyID: input["ptyID"] },
              query: { location: input["location"] },
              headers: { "x-opencode-ticket": input["x-opencode-ticket"] },
              successStatus: 200,
              declaredStatuses: [403, 404, 401, 400],
              empty: false,
            },
            requestOptions,
          ),
      },
    },
    experimental: {
      persistentPty: {
        list: (input: ExperimentalPersistentPtyListInput, requestOptions?: RequestOptions) =>
          request<{ readonly data: ExperimentalPersistentPtyListOutput }>(
            {
              operation: "persistentPty.list",
              method: "GET",
              path: `/api/experimental/session/${encodeURIComponent(input.sessionID)}/terminal`,
              params: { sessionID: input["sessionID"] },
              successStatus: 200,
              declaredStatuses: [400, 503, 401],
              empty: false,
            },
            requestOptions,
          ).then((value) => value.data),
        create: (input: ExperimentalPersistentPtyCreateInput, requestOptions?: RequestOptions) =>
          request<{ readonly data: ExperimentalPersistentPtyCreateOutput }>(
            {
              operation: "persistentPty.create",
              method: "POST",
              path: `/api/experimental/session/${encodeURIComponent(input.sessionID)}/terminal`,
              params: { sessionID: input["sessionID"] },
              body: {
                command: input["command"],
                args: input["args"],
                cwd: input["cwd"],
                title: input["title"],
                env: input["env"],
                size: input["size"],
              },
              successStatus: 200,
              declaredStatuses: [400, 503, 401],
              empty: false,
            },
            requestOptions,
          ).then((value) => value.data),
        shutdown: (requestOptions?: RequestOptions) =>
          request<ExperimentalPersistentPtyShutdownOutput>(
            {
              operation: "persistentPty.shutdown",
              method: "POST",
              path: `/api/experimental/persistent-pty/shutdown`,
              successStatus: 204,
              declaredStatuses: [503, 401, 400],
              empty: true,
            },
            requestOptions,
          ),
        get: (input: ExperimentalPersistentPtyGetInput, requestOptions?: RequestOptions) =>
          request<{ readonly data: ExperimentalPersistentPtyGetOutput }>(
            {
              operation: "persistentPty.get",
              method: "GET",
              path: `/api/experimental/persistent-pty/${encodeURIComponent(input.ptyID)}`,
              params: { ptyID: input["ptyID"] },
              successStatus: 200,
              declaredStatuses: [404, 503, 401, 400],
              empty: false,
            },
            requestOptions,
          ).then((value) => value.data),
        update: (input: ExperimentalPersistentPtyUpdateInput, requestOptions?: RequestOptions) =>
          request<{ readonly data: ExperimentalPersistentPtyUpdateOutput }>(
            {
              operation: "persistentPty.update",
              method: "PUT",
              path: `/api/experimental/persistent-pty/${encodeURIComponent(input.ptyID)}`,
              params: { ptyID: input["ptyID"] },
              body: { attachmentID: input["attachmentID"], size: input["size"] },
              successStatus: 200,
              declaredStatuses: [404, 503, 401, 400],
              empty: false,
            },
            requestOptions,
          ).then((value) => value.data),
        snapshot: (input: ExperimentalPersistentPtySnapshotInput, requestOptions?: RequestOptions) =>
          request<{ readonly data: ExperimentalPersistentPtySnapshotOutput }>(
            {
              operation: "persistentPty.snapshot",
              method: "GET",
              path: `/api/experimental/persistent-pty/${encodeURIComponent(input.ptyID)}/snapshot`,
              params: { ptyID: input["ptyID"] },
              successStatus: 200,
              declaredStatuses: [404, 503, 401, 400],
              empty: false,
            },
            requestOptions,
          ).then((value) => value.data),
        remove: (input: ExperimentalPersistentPtyRemoveInput, requestOptions?: RequestOptions) =>
          request<ExperimentalPersistentPtyRemoveOutput>(
            {
              operation: "persistentPty.remove",
              method: "DELETE",
              path: `/api/experimental/persistent-pty/${encodeURIComponent(input.ptyID)}`,
              params: { ptyID: input["ptyID"] },
              successStatus: 204,
              declaredStatuses: [404, 503, 401, 400],
              empty: true,
            },
            requestOptions,
          ),
        connectToken: (input: ExperimentalPersistentPtyConnectTokenInput, requestOptions?: RequestOptions) =>
          request<{ readonly data: ExperimentalPersistentPtyConnectTokenOutput }>(
            {
              operation: "persistentPty.connectToken",
              method: "POST",
              path: `/api/experimental/persistent-pty/${encodeURIComponent(input.ptyID)}/connect-token`,
              params: { ptyID: input["ptyID"] },
              headers: { "x-opencode-ticket": input["x-opencode-ticket"] },
              successStatus: 200,
              declaredStatuses: [403, 404, 503, 401, 400],
              empty: false,
            },
            requestOptions,
          ).then((value) => value.data),
      },
    },
    shell: {
      list: (input?: ShellListInput, requestOptions?: RequestOptions) =>
        request<ShellListOutput>(
          {
            operation: "shell.list",
            method: "GET",
            path: `/api/shell`,
            query: { location: input?.["location"] },
            successStatus: 200,
            declaredStatuses: [401, 400],
            empty: false,
          },
          requestOptions,
        ),
      create: (input: ShellCreateInput, requestOptions?: RequestOptions) =>
        request<ShellCreateOutput>(
          {
            operation: "shell.create",
            method: "POST",
            path: `/api/shell`,
            query: { location: input["location"] },
            body: {
              command: input["command"],
              cwd: input["cwd"],
              timeout: input["timeout"],
              metadata: input["metadata"],
            },
            successStatus: 200,
            declaredStatuses: [401, 400],
            empty: false,
          },
          requestOptions,
        ),
      get: (input: ShellGetInput, requestOptions?: RequestOptions) =>
        request<ShellGetOutput>(
          {
            operation: "shell.get",
            method: "GET",
            path: `/api/shell/${encodeURIComponent(input.id)}`,
            params: { id: input["id"] },
            query: { location: input["location"] },
            successStatus: 200,
            declaredStatuses: [404, 401, 400],
            empty: false,
          },
          requestOptions,
        ),
      timeout: (input: ShellTimeoutInput, requestOptions?: RequestOptions) =>
        request<ShellTimeoutOutput>(
          {
            operation: "shell.timeout",
            method: "PATCH",
            path: `/api/shell/${encodeURIComponent(input.id)}/timeout`,
            params: { id: input["id"] },
            query: { location: input["location"] },
            body: { timeout: input["timeout"] },
            successStatus: 200,
            declaredStatuses: [404, 401, 400],
            empty: false,
          },
          requestOptions,
        ),
      output: (input: ShellOutputInput, requestOptions?: RequestOptions) =>
        request<ShellOutputOutput>(
          {
            operation: "shell.output",
            method: "GET",
            path: `/api/shell/${encodeURIComponent(input.id)}/output`,
            params: { id: input["id"] },
            query: { location: input["location"], cursor: input["cursor"], limit: input["limit"] },
            successStatus: 200,
            declaredStatuses: [404, 401, 400],
            empty: false,
          },
          requestOptions,
        ),
      remove: (input: ShellRemoveInput, requestOptions?: RequestOptions) =>
        request<ShellRemoveOutput>(
          {
            operation: "shell.remove",
            method: "DELETE",
            path: `/api/shell/${encodeURIComponent(input.id)}`,
            params: { id: input["id"] },
            query: { location: input["location"] },
            successStatus: 204,
            declaredStatuses: [404, 401, 400],
            empty: true,
          },
          requestOptions,
        ),
    },
    reference: {
      list: (input?: ReferenceListInput, requestOptions?: RequestOptions) =>
        request<ReferenceListOutput>(
          {
            operation: "reference.list",
            method: "GET",
            path: `/api/reference`,
            query: { location: input?.["location"] },
            successStatus: 200,
            declaredStatuses: [401, 400],
            empty: false,
          },
          requestOptions,
        ),
    },
    worktree: {
      list: (input: WorktreeListInput, requestOptions?: RequestOptions) =>
        request<WorktreeListOutput>(
          {
            operation: "worktree.list",
            method: "GET",
            path: `/api/worktree/${encodeURIComponent(input.projectID)}`,
            params: { projectID: input["projectID"] },
            successStatus: 200,
            declaredStatuses: [401, 400],
            empty: false,
          },
          requestOptions,
        ),
      create: (input: WorktreeCreateInput, requestOptions?: RequestOptions) =>
        request<WorktreeCreateOutput>(
          {
            operation: "worktree.create",
            method: "POST",
            path: `/api/worktree/${encodeURIComponent(input.projectID)}`,
            params: { projectID: input["projectID"] },
            body: {
              strategy: input["strategy"],
              from: input["from"],
              branch: input["branch"],
              directory: input["directory"],
              name: input["name"],
            },
            successStatus: 200,
            declaredStatuses: [400, 401],
            empty: false,
          },
          requestOptions,
        ),
      remove: (input: WorktreeRemoveInput, requestOptions?: RequestOptions) =>
        request<WorktreeRemoveOutput>(
          {
            operation: "worktree.remove",
            method: "DELETE",
            path: `/api/worktree/${encodeURIComponent(input.projectID)}`,
            params: { projectID: input["projectID"] },
            body: { directory: input["directory"], force: input["force"] },
            successStatus: 204,
            declaredStatuses: [400, 401],
            empty: true,
          },
          requestOptions,
        ),
      refresh: (input: WorktreeRefreshInput, requestOptions?: RequestOptions) =>
        request<WorktreeRefreshOutput>(
          {
            operation: "worktree.refresh",
            method: "POST",
            path: `/api/worktree/${encodeURIComponent(input.projectID)}/refresh`,
            params: { projectID: input["projectID"] },
            successStatus: 204,
            declaredStatuses: [400, 401],
            empty: true,
          },
          requestOptions,
        ),
    },
    workspace: {
      create: (input: WorkspaceCreateInput, requestOptions?: RequestOptions) =>
        request<{ readonly data: WorkspaceCreateOutput }>(
          {
            operation: "workspace.create",
            method: "POST",
            path: `/api/workspace`,
            body: { id: input["id"], provider: input["provider"] },
            successStatus: 200,
            declaredStatuses: [409, 404, 401, 400],
            empty: false,
          },
          requestOptions,
        ).then((value) => value.data),
      destroy: (input: WorkspaceDestroyInput, requestOptions?: RequestOptions) =>
        request<WorkspaceDestroyOutput>(
          {
            operation: "workspace.destroy",
            method: "DELETE",
            path: `/api/workspace/${encodeURIComponent(input.workspaceID)}`,
            params: { workspaceID: input["workspaceID"] },
            successStatus: 200,
            declaredStatuses: [500, 401, 400],
            empty: false,
          },
          requestOptions,
        ),
    },
    vcs: {
      get: (input?: VcsGetInput, requestOptions?: RequestOptions) =>
        request<VcsGetOutput>(
          {
            operation: "vcs.get",
            method: "GET",
            path: `/api/vcs`,
            query: { location: input?.["location"] },
            successStatus: 200,
            declaredStatuses: [401, 400],
            empty: false,
          },
          requestOptions,
        ),
      status: (input?: VcsStatusInput, requestOptions?: RequestOptions) =>
        request<VcsStatusOutput>(
          {
            operation: "vcs.status",
            method: "GET",
            path: `/api/vcs/status`,
            query: { location: input?.["location"] },
            successStatus: 200,
            declaredStatuses: [401, 400],
            empty: false,
          },
          requestOptions,
        ),
      branches: (input?: VcsBranchesInput, requestOptions?: RequestOptions) =>
        request<VcsBranchesOutput>(
          {
            operation: "vcs.branches",
            method: "GET",
            path: `/api/vcs/branches`,
            query: { location: input?.["location"], search: input?.["search"], limit: input?.["limit"] },
            successStatus: 200,
            declaredStatuses: [401, 400],
            empty: false,
          },
          requestOptions,
        ),
      diff: (input: VcsDiffInput, requestOptions?: RequestOptions) =>
        request<VcsDiffOutput>(
          {
            operation: "vcs.diff",
            method: "GET",
            path: `/api/vcs/diff`,
            query: { location: input["location"], mode: input["mode"], context: input["context"] },
            successStatus: 200,
            declaredStatuses: [401, 400],
            empty: false,
          },
          requestOptions,
        ),
    },
    debug: {
      location: {
        list: (requestOptions?: RequestOptions) =>
          request<DebugLocationListOutput>(
            {
              operation: "debug.location",
              method: "GET",
              path: `/api/debug/location`,
              successStatus: 200,
              declaredStatuses: [401, 400],
              empty: false,
            },
            requestOptions,
          ),
        evict: (input?: DebugLocationEvictInput, requestOptions?: RequestOptions) =>
          request<DebugLocationEvictOutput>(
            {
              operation: "debug.location.evict",
              method: "DELETE",
              path: `/api/debug/location`,
              query: { location: input?.["location"] },
              successStatus: 204,
              declaredStatuses: [401, 400],
              empty: true,
            },
            requestOptions,
          ),
      },
    },
    migration: {
      v1: {
        status: (requestOptions?: RequestOptions) =>
          request<MigrationV1StatusOutput>(
            {
              operation: "migration.v1.status",
              method: "GET",
              path: `/api/experimental/migration/v1`,
              successStatus: 200,
              declaredStatuses: [401, 400],
              empty: false,
            },
            requestOptions,
          ),
      },
    },
    websearch: {
      providers: (input?: WebsearchProvidersInput, requestOptions?: RequestOptions) =>
        request<WebsearchProvidersOutput>(
          {
            operation: "websearch.providers",
            method: "GET",
            path: `/api/websearch/provider`,
            query: { location: input?.["location"] },
            successStatus: 200,
            declaredStatuses: [503, 401, 400],
            empty: false,
          },
          requestOptions,
        ),
      query: (input: WebsearchQueryInput, requestOptions?: RequestOptions) =>
        request<WebsearchQueryOutput>(
          {
            operation: "websearch.query",
            method: "POST",
            path: `/api/websearch`,
            query: { location: input["location"] },
            body: { query: input["query"], providerID: input["providerID"] },
            successStatus: 200,
            declaredStatuses: [400, 503, 401],
            empty: false,
          },
          requestOptions,
        ),
    },
    config: {
      get: (input?: ConfigGetInput, requestOptions?: RequestOptions) =>
        request<ConfigGetOutput>(
          {
            operation: "config.get",
            method: "GET",
            path: `/api/config`,
            query: { location: input?.["location"] },
            successStatus: 200,
            declaredStatuses: [401, 400],
            empty: false,
          },
          requestOptions,
        ),
    },
  }
}

function encodePath(value: string): string {
  return value.split("/").map(encodeURIComponent).join("/")
}

function appendQuery(params: URLSearchParams, key: string, value: unknown): void {
  if (value === undefined) return
  if (value === null) {
    params.append(key, "null")
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) appendQuery(params, key, item)
    return
  }
  if (typeof value === "object") {
    for (const [child, item] of Object.entries(value)) appendQuery(params, `${key}[${child}]`, item)
    return
  }
  params.append(key, String(value))
}

async function json(response: Response): Promise<unknown> {
  if (!isContentType(response, "application/json") && !response.headers.get("content-type")?.includes("+json")) {
    try {
      await response.body?.cancel()
    } catch {}
    throw new ClientError("UnsupportedContentType")
  }
  let text: string
  try {
    text = await response.text()
  } catch (cause) {
    throw new ClientError("Transport", { cause })
  }
  if (text === "") throw new ClientError("MalformedResponse")
  try {
    return JSON.parse(text)
  } catch (cause) {
    throw new ClientError("MalformedResponse", { cause })
  }
}

function isContentType(response: Response, expected: string) {
  return response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() === expected
}
