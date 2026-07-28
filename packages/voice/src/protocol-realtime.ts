import type { VoiceConnection, VoiceProtocol, VoiceProtocolEvent, VoiceProtocolOptions } from "./protocol"
import { decodeVoiceToolInput } from "./protocol"
import { Option, Schema } from "effect"

const RealtimeItem = Schema.Struct({
  type: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  call_id: Schema.optional(Schema.String),
  arguments: Schema.optional(Schema.String),
})
const RealtimeFunctionCall = Schema.Struct({
  type: Schema.Literal("function_call"),
  name: Schema.String,
  call_id: Schema.String,
  arguments: Schema.String,
})
const RealtimeEvent = Schema.Struct({
  type: Schema.String,
  delta: Schema.optional(Schema.String),
  transcript: Schema.optional(Schema.String),
  item_id: Schema.optional(Schema.String),
  item: Schema.optional(RealtimeItem),
  response: Schema.optional(Schema.Struct({ output: Schema.optional(Schema.Array(RealtimeItem)) })),
  error: Schema.optional(
    Schema.Struct({
      code: Schema.optional(Schema.String),
      message: Schema.optional(Schema.String),
    }),
  ),
})
const decodeRealtimeEvent = Schema.decodeUnknownOption(Schema.fromJsonString(RealtimeEvent))
const decodeFunctionCall = Schema.decodeUnknownOption(RealtimeFunctionCall)
type RealtimeEvent = Schema.Schema.Type<typeof RealtimeEvent>

export function createRealtimeProtocol(): VoiceProtocol {
  return {
    name: "realtime",
    inputActivity: "server",
    supportsTextInput: true,
    connect: connectRealtime,
  }
}

function connectRealtime(options: VoiceProtocolOptions): VoiceConnection {
  const ws = new WebSocket(`wss://api.openai.com/v1/realtime?model=${options.model}`, {
    headers: { Authorization: `Bearer ${options.apiKey}` },
  } as unknown as string[])
  const closed = Promise.withResolvers<void>()
  let closeTimer: ReturnType<typeof setTimeout> | undefined
  let notification: PromiseWithResolvers<boolean> | undefined
  let notificationTimer: ReturnType<typeof setTimeout> | undefined
  const pendingCalls = new Set<string>()
  const resolvedCalls = new Set<string>()
  const startedCalls = new Set<string>()
  let responseAwaitingWork = false

  const settleNotification = (accepted: boolean) => {
    if (!notification) return
    if (notificationTimer) clearTimeout(notificationTimer)
    notificationTimer = undefined
    notification.resolve(accepted)
    notification = undefined
  }

  const send = (event: Record<string, unknown>) => {
    if (options.debug || event["type"] !== "input_audio_buffer.append")
      options.trace?.("realtime.send", {
        type: event["type"],
        callID:
          event["item"] && typeof event["item"] === "object" && "call_id" in event["item"]
            ? event["item"].call_id
            : undefined,
      })
    if (ws.readyState !== WebSocket.OPEN) return false
    ws.send(JSON.stringify(event))
    return true
  }
  const createResponse = (text = false) =>
    send(text ? { type: "response.create", response: { output_modalities: ["text"] } } : { type: "response.create" })
  const resumeAfterWork = () => {
    if (!responseAwaitingWork || pendingCalls.size > 0) return
    responseAwaitingWork = false
    resolvedCalls.clear()
    createResponse()
  }
  const resolveFunctionCall = (id: string, output: unknown) => {
    send({
      type: "conversation.item.create",
      item: { type: "function_call_output", call_id: id, output: JSON.stringify(output) },
    })
    resolvedCalls.add(id)
    pendingCalls.delete(id)
    resumeAfterWork()
  }
  const startFunctionCall = (item: Schema.Schema.Type<typeof RealtimeItem>) => {
    if (item.type !== "function_call" || !item.name || !item.call_id || startedCalls.has(item.call_id)) return
    startedCalls.add(item.call_id)
    options.onEvent({ type: "tool.started", id: item.call_id, name: item.name })
  }
  const requestWork = (item: Schema.Schema.Type<typeof RealtimeItem>) => {
    startFunctionCall(item)
    const call = Option.getOrUndefined(decodeFunctionCall(item))
    if (!call) {
      const output = { status: "error", message: "Malformed Realtime function call." }
      options.onEvent({ type: "error", message: "Received a malformed Realtime function call." })
      if (item.call_id) {
        options.onEvent({
          type: "work.rejected",
          request: { id: item.call_id, name: item.name ?? "tool", input: {} },
          output,
        })
        startedCalls.delete(item.call_id)
      }
      return
    }
    pendingCalls.add(call.call_id)
    const input = Option.getOrUndefined(decodeVoiceToolInput(call.arguments))
    if (!input) {
      const output = { status: "error", message: `Invalid arguments for tool ${call.name}.` }
      options.onEvent({ type: "error", message: `Received invalid arguments for Realtime tool ${call.name}.` })
      options.onEvent({
        type: "work.rejected",
        request: { id: call.call_id, name: call.name, input: {} },
        output,
      })
      startedCalls.delete(call.call_id)
      return
    }
    options.onEvent({
      type: "work.requested",
      request: { id: call.call_id, name: call.name, input },
    })
    startedCalls.delete(call.call_id)
  }
  const finishResponse = (output: ReadonlyArray<Schema.Schema.Type<typeof RealtimeItem>>) => {
    const callIDs = output.flatMap((item) => (item.type === "function_call" && item.call_id ? [item.call_id] : []))
    callIDs.filter((id) => !resolvedCalls.has(id)).forEach((id) => pendingCalls.add(id))
    responseAwaitingWork = callIDs.length > 0
    options.onEvent({ type: "assistant.done", awaitingWork: responseAwaitingWork })
    resumeAfterWork()
  }

  ws.addEventListener("open", () => {
    send({
      type: "session.update",
      session: {
        type: "realtime",
        instructions: options.instructions,
        tools: options.tools,
        tool_choice: "auto",
        audio: { output: { voice: options.voice } },
      },
    })
    send({
      type: "session.update",
      session: { type: "realtime", audio: { input: { transcription: { model: "whisper-1" } } } },
    })
    send({
      type: "session.update",
      session: {
        type: "realtime",
        audio: {
          input: {
            turn_detection: {
              type: "server_vad",
              silence_duration_ms: 900,
              interrupt_response: options.fullDuplex,
            },
          },
        },
      },
    })
  })
  ws.addEventListener("message", (event) => {
    const data = Option.getOrUndefined(decodeRealtimeEvent(String(event.data)))
    if (!data) {
      options.onEvent({ type: "error", message: "Received an invalid Realtime API event." })
      return
    }
    if (options.debug || data.type !== "response.output_audio.delta")
      options.trace?.("realtime.receive", { type: data.type })
    if (data.type === "conversation.item.created") settleNotification(true)
    onMessage(data, options.onEvent, startFunctionCall, requestWork, finishResponse)
  })
  ws.addEventListener("close", (event) => {
    if (closeTimer) clearTimeout(closeTimer)
    settleNotification(false)
    options.onEvent({ type: "closed", code: event.code })
    closed.resolve()
  })

  return {
    appendAudio(audio) {
      if (ws.bufferedAmount > 96_000) {
        options.trace?.("realtime.audio.dropped", { bytes: audio.length, buffered: ws.bufferedAmount })
        return
      }
      send({ type: "input_audio_buffer.append", audio: audio.toString("base64") })
    },
    sendText(text) {
      send({
        type: "conversation.item.create",
        item: { type: "message", role: "user", content: [{ type: "input_text", text }] },
      })
      createResponse(true)
    },
    resolveWork(request, output) {
      resolveFunctionCall(request.id, output)
    },
    notify(text) {
      if (notification) return Promise.resolve(false)
      notification = Promise.withResolvers<boolean>()
      const created = send({
        type: "conversation.item.create",
        item: { type: "message", role: "user", content: [{ type: "input_text", text }] },
      })
      if (!created || !createResponse()) {
        settleNotification(false)
        return Promise.resolve(false)
      }
      notificationTimer = setTimeout(() => settleNotification(false), 5_000)
      return notification.promise
    },
    interrupt() {
      send({ type: "response.cancel" })
      return true
    },
    close() {
      if (ws.readyState === WebSocket.CLOSED) return Promise.resolve()
      ws.close(1000)
      closeTimer ??= setTimeout(() => closed.resolve(), 5_000)
      return closed.promise
    },
  }
}

function onMessage(
  data: RealtimeEvent,
  emit: (event: VoiceProtocolEvent) => void,
  startFunctionCall: (item: Schema.Schema.Type<typeof RealtimeItem>) => void,
  requestWork: (item: Schema.Schema.Type<typeof RealtimeItem>) => void,
  finishResponse: (output: ReadonlyArray<Schema.Schema.Type<typeof RealtimeItem>>) => void,
) {
  if (!data.type.endsWith(".delta")) emit({ type: "debug", message: data.type })
  switch (data.type) {
    case "session.created":
      emit({ type: "ready" })
      return
    case "response.output_text.delta":
    case "response.output_audio_transcript.delta":
      emit({ type: "assistant.transcript.delta", delta: data.delta ?? "" })
      return
    case "response.done":
      finishResponse(data.response?.output ?? [])
      return
    case "input_audio_buffer.speech_started":
      emit({ type: "user.started" })
      return
    case "input_audio_buffer.speech_stopped":
      emit({ type: "user.stopped" })
      return
    case "input_audio_buffer.committed":
      emit({ type: "user.committed", id: data.item_id ?? "" })
      return
    case "conversation.item.input_audio_transcription.completed":
      emit({ type: "user.transcript", id: data.item_id ?? "", text: (data.transcript ?? "").trim(), final: true })
      return
    case "response.output_audio.delta":
      if (data.delta) emit({ type: "assistant.audio", audio: Buffer.from(data.delta, "base64") })
      return
    case "response.output_item.added":
      if (data.item?.type === "function_call") startFunctionCall(data.item)
      return
    case "response.output_item.done":
      if (data.item?.type === "function_call") requestWork(data.item)
      return
    case "error":
      emit({ type: "error", message: `${data.error?.code}: ${data.error?.message}` })
  }
}
