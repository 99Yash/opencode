import type {
  AgentPart,
  AssistantMessage,
  EventSubscribeOutput,
  FileDiffInfo,
  FileDiffLegacyInfo,
  FilePart,
  FilePartSource,
  Message,
  Part,
  Project,
  QuestionAnswer,
  QuestionInfo,
  QuestionV2Request,
  ReferenceInfo,
  SessionInfo,
  SessionNotFoundError,
  SessionStatus,
  SessionV1Info,
  SessionsResponse,
  TextPart,
  ToolPart,
  UserMessage,
} from "@opencode-ai/client/promise"
import type { NormalizedProviderListResponse } from "@opencode-ai/session-ui/context"

export type {
  AgentPart,
  AssistantMessage,
  FilePart,
  FilePartSource,
  Message,
  Part,
  Project,
  QuestionAnswer,
  ReferenceInfo,
  SessionNotFoundError,
  SessionStatus,
  TextPart,
  ToolPart,
  UserMessage,
}

export type Session = SessionV1Info
export type SessionV2Info = SessionInfo
export type V2SessionListResponse = SessionsResponse
export type QuestionRequest = QuestionV2Request
export type SnapshotFileDiff = FileDiffLegacyInfo
export type VcsFileDiff = FileDiffInfo

export type Event = EventSubscribeOutput extends infer Item
  ? Item extends { type: infer Type extends string; data: infer Data }
    ? { type: Type; properties: Data }
    : never
  : never

export type EventSessionError = Extract<Event, { type: "session.error" }>

export type PermissionRequest = {
  id: string
  sessionID: string
  permission: string
  patterns: string[]
  metadata: Record<string, unknown>
  always: string[]
  tool?: { messageID: string; callID: string }
}

export type Todo = {
  content: string
  status: string
  priority: string
}

export type FileNode = {
  name: string
  path: string
  absolute: string
  type: "file" | "directory"
  ignored: boolean
}

export type FileContent = {
  type: "text" | "binary"
  content: string
  diff?: string
  patch?: {
    oldFileName: string
    newFileName: string
    oldHeader?: string
    newHeader?: string
    hunks: Array<{
      oldStart: number
      oldLines: number
      newStart: number
      newLines: number
      lines: string[]
    }>
    index?: string
  }
  encoding?: "base64"
  mimeType?: string
}

export type Path = {
  home: string
  state: string
  config: string
  worktree: string
  directory: string
}

export type VcsInfo = { branch?: string; default_branch?: string }
export type LspStatus = { id: string; name: string; root: string; status: "connected" | "error" }

export type Agent = {
  name: string
  description?: string
  mode: "subagent" | "primary" | "all"
  native?: boolean
  hidden?: boolean
  topP?: number
  temperature?: number
  color?: string
  permission: Array<{ permission: string; pattern: string; action: "allow" | "deny" | "ask" }>
  model?: { modelID: string; providerID: string }
  variant?: string
  prompt?: string
  options: Record<string, unknown>
  steps?: number
}

export type Provider = NormalizedProviderListResponse["all"] extends Map<string, infer Item> ? Item : never
export type Model = Provider["models"][string]
export type ProviderListResponse = NormalizedProviderListResponse

export type ProviderAuthResponse = Record<string, unknown>

export type Config = {
  model?: string
  small_model?: string
  default_agent?: string
  username?: string
  share?: "manual" | "auto" | "disabled"
  autoshare?: boolean
  shell?: string
  plugin?: Array<string | [string, Record<string, unknown>]>
  provider?: Record<string, { npm?: string; models?: Record<string, unknown> }>
  mcp?: Record<string, unknown>
  agent?: Record<string, unknown>
  command?: Record<string, unknown>
  instructions?: string[]
  disabled_providers?: string[]
  enabled_providers?: string[]
  permission?: string | Record<string, unknown>
  tools?: Record<string, boolean>
  experimental?: Record<string, unknown>
  [key: string]: unknown
}

export type TextPartInput = Omit<TextPart, "id" | "sessionID" | "messageID"> & { id?: string }
export type FilePartInput = Omit<FilePart, "id" | "sessionID" | "messageID"> & { id?: string }
export type AgentPartInput = Omit<AgentPart, "id" | "sessionID" | "messageID"> & { id?: string }

export type Question = QuestionInfo
