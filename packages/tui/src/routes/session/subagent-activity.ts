import type {
  FormInfo,
  PermissionRequest,
  SessionInfo,
  SessionMessageAssistantTool,
  SessionMessageInfo,
} from "@opencode-ai/client"
import { Locale } from "../../util/locale"
import { sessionFamily } from "../../util/session"
import { canonicalToolName } from "../../util/tool-display"
import { withTimestampedFallback } from "@opencode-ai/util/session-title-fallback"

export type SubagentActivity = {
  sessionID: string
  parentID?: string
  agent: string
  title: string
  prefix: string
  status: "starting" | "running" | "permission" | "question" | "retry" | "completed" | "error" | "cancelled"
  activity: string
  tools: number
  started: number
  ended?: number
  background: boolean
  model?: string
  cost: number
}

export function collectSubagentActivity(input: {
  sessionID: string
  sessions: readonly SessionInfo[]
  messages: (sessionID: string) => readonly SessionMessageInfo[]
  status: (sessionID: string) => "running" | "idle"
  permissions: (sessionID: string) => readonly PermissionRequest[] | undefined
  forms: (sessionID: string) => readonly FormInfo[] | undefined
}): SubagentActivity[] {
  return sessionFamily(input.sessions, input.sessionID).map(({ session, prefix }) => {
    const messages = input.messages(session.id)
    const assistant = messages.findLast((message) => message.type === "assistant")
    const tools = messages.flatMap((message) =>
      message.type === "assistant"
        ? message.content.flatMap((part): SessionMessageAssistantTool[] => (part.type === "tool" ? [part] : []))
        : [],
    )
    const permission = input.permissions(session.id)?.[0]
    const form = input.forms(session.id)?.[0]
    const retry = assistant?.type === "assistant" ? assistant.retry : undefined
    const active = input.status(session.id) === "running"
    const status = permission
      ? "permission"
      : form
        ? "question"
        : retry
          ? "retry"
          : active
            ? "running"
            : session.outcome === "failed"
              ? "error"
              : session.outcome === "interrupted"
                ? "cancelled"
                : session.outcome === "succeeded" || session.time.idle !== undefined
                  ? "completed"
                  : "starting"
    const current = tools.findLast((tool) => tool.state.status === "running") ?? tools.at(-1)
    const value = current?.state.status === "streaming" ? undefined : current?.state.input
    const detail = value
      ? ["description", "command", "path", "pattern", "query", "url"].flatMap((key) =>
          typeof value[key] === "string" && value[key].trim() ? [value[key]] : [],
        )[0]
      : undefined
    const activity = permission
      ? `Approval: ${permission.action}${permission.resources[0] ? ` ${permission.resources[0]}` : ""}`
      : form
        ? (form.fields[0]?.description ?? form.title)
        : retry
          ? `Retry ${retry.attempt}: ${retry.error.message}`
          : current
            ? `${Locale.titlecase(canonicalToolName(current.name))}${detail ? ` ${detail}` : ""}`
            : status === "error" && assistant?.type === "assistant" && assistant.error
              ? assistant.error.message
              : status === "completed"
                ? "Completed"
                : "Starting"
    const parent = input.messages(session.parentID ?? input.sessionID)
    const delegation = parent
      .flatMap((message) =>
        message.type === "assistant"
          ? message.content.flatMap((part): SessionMessageAssistantTool[] =>
              part.type === "tool" && canonicalToolName(part.name) === "subagent" ? [part] : [],
            )
          : [],
      )
      .findLast((part) => part.state.status !== "streaming" && part.state.metadata?.sessionID === session.id)
    const title = withTimestampedFallback(session)
    const match = title.match(/@(\w+) subagent/)

    return {
      sessionID: session.id,
      parentID: session.parentID,
      agent: Locale.titlecase(session.agent ?? match?.[1] ?? "Subagent"),
      title: match ? title.replace(match[0], "").trim() || title : title,
      prefix,
      status,
      activity,
      tools: tools.filter((tool) => tool.state.status !== "streaming").length,
      started: session.time.created,
      ended: session.time.idle,
      background: delegation?.state.status === "completed" && delegation.state.metadata?.status === "running",
      model: session.model ? `${session.model.providerID}/${session.model.id}` : undefined,
      cost: session.cost,
    }
  })
}

export function subagentActive(status: SubagentActivity["status"]) {
  return (
    status === "starting" ||
    status === "running" ||
    status === "permission" ||
    status === "question" ||
    status === "retry"
  )
}

export function subagentStatusLabel(status: SubagentActivity["status"]) {
  if (status === "permission") return "Needs approval"
  if (status === "question") return "Needs answer"
  if (status === "retry") return "Retrying"
  if (status === "error") return "Failed"
  if (status === "cancelled") return "Interrupted"
  if (status === "completed") return "Completed"
  if (status === "starting") return "Starting"
  return "Running"
}
