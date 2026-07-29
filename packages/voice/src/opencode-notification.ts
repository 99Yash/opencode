import { Schema } from "effect"
import type { PromptHandle } from "./prompt-handle"

const Completed = Schema.Struct({
  type: Schema.Literal("opencode.prompt.completed"),
  session_id: Schema.String,
  prompt_id: Schema.String,
  status: Schema.Literals(["completed", "failed"]),
  text: Schema.String,
  error: Schema.optional(Schema.String),
})

const Failed = Schema.Struct({
  type: Schema.Literal("opencode.prompt.failed"),
  session_id: Schema.String,
  prompt_id: Schema.String,
  status: Schema.Literal("failed"),
  error: Schema.String,
})

const PermissionBlocked = Schema.Struct({
  type: Schema.Literal("opencode.prompt.blocked"),
  prompt_id: Schema.String,
  blocker: Schema.Literal("permission"),
  session_id: Schema.String,
  request_id: Schema.String,
  action: Schema.String,
  resources: Schema.Unknown,
})

const QuestionBlocked = Schema.Struct({
  type: Schema.Literal("opencode.prompt.blocked"),
  prompt_id: Schema.String,
  blocker: Schema.Literal("question"),
  session_id: Schema.String,
  request_id: Schema.String,
  questions: Schema.Unknown,
})

const FormBlocked = Schema.Struct({
  type: Schema.Literal("opencode.prompt.blocked"),
  prompt_id: Schema.String,
  blocker: Schema.Literal("form"),
  session_id: Schema.String,
  form_id: Schema.String,
  title: Schema.String,
  fields: Schema.Unknown,
})

const EventsFailed = Schema.Struct({
  type: Schema.Literal("opencode.events.failed"),
  error: Schema.String,
})

export const OpenCodeNotification = Schema.Union([
  Completed,
  Failed,
  PermissionBlocked,
  QuestionBlocked,
  FormBlocked,
  EventsFailed,
])
export type OpenCodeNotification = typeof OpenCodeNotification.Type
export type OpenCodePromptBlocked = Extract<OpenCodeNotification, { readonly type: "opencode.prompt.blocked" }>

export type CompletionReceipt = PromptHandle

export type OpenCodeAnnouncement = {
  readonly notification: OpenCodeNotification
  readonly receipt?: CompletionReceipt
}

export function openCodeAnnouncementText(notification: OpenCodeNotification) {
  const text = (() => {
    switch (notification.type) {
      case "opencode.prompt.completed":
        return `OpenCode prompt ${notification.status}: ${notification.text}${notification.error ? ` Error: ${notification.error}` : ""}`
      case "opencode.prompt.failed":
        return `OpenCode prompt failed: ${notification.error}`
      case "opencode.prompt.blocked":
        if (notification.blocker === "permission")
          return `OpenCode needs permission for ${notification.action}: ${compact(notification.resources)}`
        if (notification.blocker === "question")
          return `OpenCode needs the user to answer: ${compact(notification.questions)}`
        return `OpenCode needs the user to complete the form “${notification.title}”: ${compact(notification.fields)}`
      case "opencode.events.failed":
        return `OpenCode event delivery failed: ${notification.error}`
    }
    return "OpenCode has an update."
  })()
  return text.length > 800 ? text.slice(0, 797) + "..." : text
}

function compact(value: unknown) {
  if (typeof value === "string") return value
  return JSON.stringify(value) ?? String(value)
}
