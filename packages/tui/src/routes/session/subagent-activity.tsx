import type {
  FormInfo,
  PermissionRequest,
  SessionInfo,
  SessionMessageAssistantTool,
  SessionMessageInfo,
} from "@opencode-ai/client"
import type { RGBA } from "@opentui/core"
import { TextAttributes } from "@opentui/core"
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { Spinner } from "../../component/spinner"
import { useTheme } from "../../context/theme"
import { SplitBorder } from "../../ui/border"
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

export function SubagentActivityDock(props: {
  entries: readonly SubagentActivity[]
  width: number
  shortcut?: string
  agentColor?: (agent: string) => RGBA | undefined
  onOpen?: (sessionID?: string) => void
}) {
  const theme = useTheme("elevated")
  const [hovered, setHovered] = createSignal<string>()
  const [clock, setClock] = createSignal(Date.now())
  const timer = setInterval(() => setClock(Date.now()), 1000)
  onCleanup(() => clearInterval(timer))

  const attention = createMemo(() =>
    props.entries.filter((entry) => entry.status === "permission" || entry.status === "question"),
  )
  const failed = createMemo(() => props.entries.filter((entry) => entry.status === "error"))
  const running = createMemo(() =>
    props.entries.filter(
      (entry) => entry.status === "starting" || entry.status === "running" || entry.status === "retry",
    ),
  )
  const visible = createMemo(() =>
    [
      ...attention(),
      ...failed(),
      ...running(),
      ...props.entries.filter((entry) => !subagentActive(entry.status) && entry.status !== "error"),
    ].slice(0, 4),
  )
  const summary = createMemo(() =>
    [
      running().length ? `${running().length} working` : undefined,
      attention().length ? `${attention().length} ${attention().length === 1 ? "needs" : "need"} input` : undefined,
      failed().length ? `${failed().length} failed` : undefined,
    ]
      .filter(Boolean)
      .join(" · "),
  )
  const agentWidth = createMemo(() => Math.min(14, Math.max(7, ...visible().map((entry) => entry.agent.length))))
  const color = (entry: SubagentActivity) => {
    if (entry.status === "permission" || entry.status === "question" || entry.status === "retry")
      return theme.text.feedback.warning.default
    if (entry.status === "error") return theme.text.feedback.error.default
    if (entry.status === "completed") return theme.text.feedback.success.default
    return theme.text.subdued
  }
  const icon = (entry: SubagentActivity) => {
    if (entry.status === "permission") return "△"
    if (entry.status === "question") return "?"
    if (entry.status === "retry") return "↻"
    if (entry.status === "error") return "!"
    if (entry.status === "cancelled") return "○"
    return "✓"
  }

  return (
    <box
      flexShrink={0}
      border={["left"]}
      customBorderChars={SplitBorder.customBorderChars}
      borderColor={theme.border.default}
      backgroundColor={theme.background.default}
      paddingTop={1}
      paddingBottom={1}
      paddingLeft={1}
      paddingRight={1}
      gap={0}
    >
      <box flexDirection="row" paddingLeft={1} paddingBottom={1} gap={1} onMouseUp={() => props.onOpen?.()}>
        <text fg={theme.text.default} attributes={TextAttributes.BOLD} flexShrink={0}>
          Subagents
        </text>
        <Show when={summary()}>
          {(value) => (
            <text
              fg={attention().length ? theme.text.feedback.warning.default : theme.text.subdued}
              wrapMode="none"
              truncate
              flexGrow={1}
            >
              {value()}
            </text>
          )}
        </Show>
        <Show when={props.shortcut}>
          {(shortcut) => (
            <text fg={theme.text.action.secondary.default} wrapMode="none" flexShrink={0}>
              {shortcut()} inspect
            </text>
          )}
        </Show>
      </box>
      <For each={visible()}>
        {(entry) => (
          <box
            flexDirection="row"
            paddingLeft={1}
            paddingRight={1}
            gap={1}
            backgroundColor={
              hovered() === entry.sessionID
                ? theme.background.action.primary.hovered
                : theme.background.action.primary.default
            }
            onMouseOver={() => setHovered(entry.sessionID)}
            onMouseOut={() => setHovered(undefined)}
            onMouseUp={() => props.onOpen?.(entry.sessionID)}
          >
            <box width={2} flexShrink={0}>
              <Show
                when={entry.status === "running" || entry.status === "starting"}
                fallback={<text fg={color(entry)}>{icon(entry)}</text>}
              >
                <Spinner color={theme.text.subdued} />
              </Show>
            </box>
            <Show when={entry.prefix}>
              <text fg={theme.text.subdued} flexShrink={0} wrapMode="none">
                {entry.prefix}
              </text>
            </Show>
            <text
              fg={props.agentColor?.(entry.agent.toLowerCase()) ?? theme.text.default}
              width={agentWidth()}
              flexShrink={0}
              wrapMode="none"
              truncate
            >
              {entry.agent}
            </text>
            <text fg={theme.text.default} flexGrow={1} minWidth={0} wrapMode="none" truncate>
              {entry.title}
            </text>
            <Show when={entry.background}>
              <text fg={theme.text.subdued} flexShrink={0} wrapMode="none">
                {props.width >= 90 ? "background" : "bg"}
              </text>
            </Show>
            <Show when={props.width >= 72}>
              <text
                fg={color(entry)}
                maxWidth={Math.max(14, Math.floor(props.width * 0.38))}
                flexShrink={1}
                wrapMode="none"
                truncate
              >
                {entry.activity}
              </text>
            </Show>
            <Show when={props.width >= 54 && entry.started > 0}>
              <text fg={theme.text.subdued} flexShrink={0} wrapMode="none">
                {Locale.duration(Math.max(0, (entry.ended ?? clock()) - entry.started))}
              </text>
            </Show>
          </box>
        )}
      </For>
      <Show when={props.entries.length > visible().length}>
        <box paddingLeft={4}>
          <text fg={theme.text.subdued}>+{props.entries.length - visible().length} more</text>
        </box>
      </Show>
    </box>
  )
}
