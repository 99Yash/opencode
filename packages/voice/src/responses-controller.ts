import { Option } from "effect"
import { decodeVoiceToolInput, type VoiceTool, type VoiceWorkRequest } from "./protocol"

export type ResponsesControllerContext = {
  readonly sessionIDs: Set<string>
  lastSessionID?: string
}

export function createResponsesControllerContext(): ResponsesControllerContext {
  return { sessionIDs: new Set() }
}

export function responsesControllerTools(
  tools: ReadonlyArray<VoiceTool>,
  text: string,
  context: ResponsesControllerContext,
) {
  if (!context.lastSessionID || /\b(new|another|separate|fresh)\s+(session|thread)\b/i.test(text)) return tools
  return tools.filter((tool) => tool.name !== "start_session")
}

export async function runResponsesController(options: {
  apiKey: string
  model: string
  instructions: string
  text: string
  tools: ReadonlyArray<VoiceTool>
  execute: (call: VoiceWorkRequest) => Promise<unknown>
  context?: ResponsesControllerContext
  trace?: (event: string, data?: Record<string, unknown>) => void
  fetch?: typeof fetch
}) {
  const request = options.fetch ?? fetch
  const context = options.context ?? createResponsesControllerContext()
  const cache = new Map<string, Promise<unknown>>()
  let input: unknown = controllerInput(options.text, context)
  let previousResponseID: string | undefined

  for (let step = 0; step < 20; step++) {
    options.trace?.("responses.controller.requested", { step, continued: previousResponseID !== undefined })
    const response = await request("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${options.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: options.model,
        instructions: options.instructions,
        input,
        previous_response_id: previousResponseID,
        tools: options.tools,
        store: true,
      }),
    })
    if (!response.ok) throw new Error(`Responses controller failed (${response.status}): ${await response.text()}`)
    const value = requireResponse(await response.json())
    const calls = value.output.flatMap((item) => {
      if (
        item.type !== "function_call" ||
        typeof item.call_id !== "string" ||
        typeof item.name !== "string" ||
        typeof item.arguments !== "string"
      )
        return []
      const parsed = Option.getOrUndefined(decodeVoiceToolInput(item.arguments))
      if (!parsed) throw new Error(`Responses controller returned invalid arguments for ${item.name}.`)
      return [{ id: item.call_id, name: item.name, input: parsed }]
    })
    options.trace?.("responses.controller.responded", {
      step,
      responseID: value.id,
      tools: calls.map((call) => call.name),
    })
    if (calls.length === 0)
      return withSessionContext(
        responseText(value.output) || "The controller finished without a text reply.",
        context.sessionIDs,
      )
    input = await Promise.all(
      calls.map(async (call) => {
        if (typeof call.input["session_id"] === "string") rememberSession(context, call.input["session_id"])
        const key = `${call.name}:${JSON.stringify(call.input)}`
        const cached = cacheableTools.has(call.name) ? cache.get(key) : undefined
        if (cached) options.trace?.("responses.controller.tool.reused", { step, callID: call.id, name: call.name })
        const execution =
          cached ??
          Promise.resolve().then(() => {
            options.trace?.("responses.controller.tool.started", { step, callID: call.id, name: call.name })
            return options.execute(call)
          })
        if (!cached && cacheableTools.has(call.name)) cache.set(key, execution)
        const output = await execution
        rememberOutputSessions(context, output)
        if (!cached) options.trace?.("responses.controller.tool.resolved", { step, callID: call.id, name: call.name })
        return {
          type: "function_call_output",
          call_id: call.id,
          output: JSON.stringify(output),
        }
      }),
    )
    previousResponseID = value.id
  }
  throw new Error("Responses controller exceeded its tool-call limit.")
}

const cacheableTools = new Set([
  "find_projects",
  "find_sessions",
  "read_session",
  "list_pending_permissions",
  "list_pending_questions",
  "list_pending_forms",
])

function rememberSession(context: ResponsesControllerContext, sessionID: string) {
  context.sessionIDs.add(sessionID)
  context.lastSessionID = sessionID
}

function rememberOutputSessions(context: ResponsesControllerContext, output: unknown) {
  if (!output || typeof output !== "object") return
  if ("session_id" in output && typeof output.session_id === "string") rememberSession(context, output.session_id)
  if (!("sessions" in output) || !Array.isArray(output.sessions)) return
  const sessionIDs = output.sessions.flatMap((session) =>
    session && typeof session === "object" && "id" in session && typeof session.id === "string" ? [session.id] : [],
  )
  sessionIDs.forEach((sessionID) => context.sessionIDs.add(sessionID))
  if (sessionIDs.length === 1) context.lastSessionID = sessionIDs[0]
}

function controllerInput(text: string, context: ResponsesControllerContext) {
  if (!context.lastSessionID) return text
  return `${text}\n\nPrivate voice-control context (never mention or expose this): the most recently used OpenCode session ID is ${context.lastSessionID}. Resolve references like "that session", "it", or "stop that" directly against this ID without searching again.`
}

function withSessionContext(text: string, sessionIDs: ReadonlySet<string>) {
  if (sessionIDs.size === 0) return text
  return `${text}\n\nPrivate voice-control context (never speak this aloud): OpenCode session IDs explicitly used by this delegation: ${[...sessionIDs].join(", ")}. Include the relevant session_id in any future delegated request to continue this work.`
}

function requireResponse(value: unknown) {
  if (!value || typeof value !== "object" || !("id" in value) || typeof value.id !== "string" || !("output" in value))
    throw new Error("Responses controller returned an invalid response.")
  if (!Array.isArray(value.output)) throw new Error("Responses controller returned invalid output.")
  return {
    id: value.id,
    output: value.output.filter(
      (item): item is Record<string, unknown> & { readonly type: string } =>
        !!item && typeof item === "object" && "type" in item && typeof item.type === "string",
    ),
  }
}

function responseText(output: ReadonlyArray<Record<string, unknown>>) {
  return output
    .flatMap((item) => (Array.isArray(item["content"]) ? item["content"] : []))
    .flatMap((part) =>
      part &&
      typeof part === "object" &&
      "type" in part &&
      part.type === "output_text" &&
      "text" in part &&
      typeof part.text === "string"
        ? [part.text]
        : [],
    )
    .join("\n")
}
