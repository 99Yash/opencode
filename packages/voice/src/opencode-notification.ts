import { Schema } from "effect"

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
