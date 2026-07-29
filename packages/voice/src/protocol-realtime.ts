import type { VoiceConnection, VoiceProtocol, VoiceProtocolEvent, VoiceProtocolOptions } from "./protocol"
import { decodeVoiceToolInput } from "./protocol"
import { Option, Schema } from "effect"
import { createSingleFlightAcknowledgement } from "./single-flight-acknowledgement"

const RealtimeItem = Schema.Struct({
  id: Schema.optional(Schema.String),
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
      event_id: Schema.optional(Schema.String),
    }),
  ),
})
const decodeRealtimeEvent = Schema.decodeUnknownOption(Schema.fromJsonString(RealtimeEvent))
const decodeFunctionCall = Schema.decodeUnknownOption(RealtimeFunctionCall)
type RealtimeEvent = Schema.Schema.Type<typeof RealtimeEvent>
type RealtimeProjectorCommand = { readonly type: "response.create" }

export function createRealtimeEventProjector() {
  const pendingCalls = new Set<string>()
  const resolvedCalls = new Set<string>()
  const startedCalls = new Set<string>()
  const projectedCalls = new Set<string>()
  let responseAwaitingWork = false

  const resumeAfterWork = (): ReadonlyArray<RealtimeProjectorCommand> => {
    if (!responseAwaitingWork || pendingCalls.size > 0) return []
    responseAwaitingWork = false
    resolvedCalls.clear()
    return [{ type: "response.create" }]
  }

  return {
    receive(raw: string) {
      const event = Option.getOrUndefined(decodeRealtimeEvent(raw))
      if (!event)
        return {
          type: "invalid",
          events: [{ type: "error", message: "Received an invalid Realtime API event." }] satisfies VoiceProtocolEvent[],
          commands: [] as ReadonlyArray<RealtimeProjectorCommand>,
        }
      const events: VoiceProtocolEvent[] = event.type.endsWith(".delta")
        ? []
        : [{ type: "debug", message: event.type }]
      const commands: RealtimeProjectorCommand[] = []
      switch (event.type) {
        case "session.created":
          events.push({ type: "ready" })
          break
        case "response.output_text.delta":
        case "response.output_audio_transcript.delta":
          events.push({ type: "assistant.transcript.delta", delta: event.delta ?? "" })
          break
        case "response.done": {
          const callIDs = (event.response?.output ?? []).flatMap((item) =>
            item.type === "function_call" && item.call_id ? [item.call_id] : [],
          )
          callIDs.filter((id) => !resolvedCalls.has(id)).forEach((id) => pendingCalls.add(id))
          responseAwaitingWork = callIDs.length > 0
          events.push({ type: "assistant.done", awaitingWork: responseAwaitingWork })
          commands.push(...resumeAfterWork())
          break
        }
        case "input_audio_buffer.speech_started":
          events.push({ type: "user.started" })
          break
        case "input_audio_buffer.speech_stopped":
          events.push({ type: "user.stopped" })
          break
        case "input_audio_buffer.committed":
          events.push({ type: "user.committed", id: event.item_id ?? "" })
          break
        case "conversation.item.input_audio_transcription.completed":
          events.push({
            type: "user.transcript",
            id: event.item_id ?? "",
            text: (event.transcript ?? "").trim(),
            final: true,
          })
          break
        case "response.output_audio.delta":
          if (event.delta) events.push({ type: "assistant.audio", audio: Buffer.from(event.delta, "base64") })
          break
        case "response.output_item.added":
          if (
            event.item?.type === "function_call" &&
            event.item.name &&
            event.item.call_id &&
            !startedCalls.has(event.item.call_id)
          ) {
            startedCalls.add(event.item.call_id)
            events.push({ type: "tool.started", id: event.item.call_id, name: event.item.name })
          }
          break
        case "response.output_item.done": {
          if (event.item?.type !== "function_call") break
          if (event.item.call_id && projectedCalls.has(event.item.call_id)) break
          if (event.item.name && event.item.call_id && !startedCalls.has(event.item.call_id)) {
            startedCalls.add(event.item.call_id)
            events.push({ type: "tool.started", id: event.item.call_id, name: event.item.name })
          }
          const call = Option.getOrUndefined(decodeFunctionCall(event.item))
          if (!call) {
            events.push({ type: "error", message: "Received a malformed Realtime function call." })
            if (event.item.call_id)
              events.push({
                type: "work.rejected",
                request: { id: event.item.call_id, name: event.item.name ?? "tool", input: {} },
                output: { status: "error", message: "Malformed Realtime function call." },
              })
            if (event.item.call_id) startedCalls.delete(event.item.call_id)
            if (event.item.call_id) projectedCalls.add(event.item.call_id)
            break
          }
          pendingCalls.add(call.call_id)
          const input = Option.getOrUndefined(decodeVoiceToolInput(call.arguments))
          if (!input) {
            events.push({ type: "error", message: `Received invalid arguments for Realtime tool ${call.name}.` })
            events.push({
              type: "work.rejected",
              request: { id: call.call_id, name: call.name, input: {} },
              output: { status: "error", message: `Invalid arguments for tool ${call.name}.` },
            })
            startedCalls.delete(call.call_id)
            projectedCalls.add(call.call_id)
            break
          }
          events.push({ type: "work.requested", request: { id: call.call_id, name: call.name, input } })
          startedCalls.delete(call.call_id)
          projectedCalls.add(call.call_id)
          break
        }
        case "error":
          events.push({ type: "error", message: `${event.error?.code}: ${event.error?.message}` })
      }
      return { type: event.type, event, events, commands }
    },
    resolveWork(id: string) {
      resolvedCalls.add(id)
      pendingCalls.delete(id)
      return resumeAfterWork()
    },
  }
}

export function realtimeNotificationAcknowledgement(
  event: Pick<RealtimeEvent, "type" | "item" | "error">,
  pending: { readonly itemID: string; readonly eventID: string },
) {
  if (event.type === "conversation.item.created" && event.item?.id === pending.itemID) return true
  if (event.type === "error" && event.error?.event_id === pending.eventID) return false
  return undefined
}

export function createRealtimeProtocol(): VoiceProtocol {
  return {
    name: "realtime",
    inputActivity: "server",
    capabilities: { textInput: true, interruption: true, delegation: false },
    connect: connectRealtime,
  }
}

export function realtimeSessionUpdate(
  options: Pick<VoiceProtocolOptions, "instructions" | "tools" | "voice">,
) {
  return {
    type: "session.update",
    session: {
      type: "realtime",
      instructions: options.instructions,
      tools: options.tools,
      tool_choice: "auto",
      audio: { output: { voice: options.voice } },
    },
  }
}

function connectRealtime(options: VoiceProtocolOptions): VoiceConnection {
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- Bun accepts WebSocket headers in this runtime-only overload.
  const ws = new WebSocket(`wss://api.openai.com/v1/realtime?model=${options.model}`, {
    headers: { Authorization: `Bearer ${options.apiKey}` },
  } as unknown as string[])
  const closed = Promise.withResolvers<void>()
  let closeTimer: ReturnType<typeof setTimeout> | undefined
  const notification = createSingleFlightAcknowledgement<{ readonly itemID: string; readonly eventID: string }>()
  const projector = createRealtimeEventProjector()

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
  const resolveFunctionCall = (id: string, output: unknown) => {
    send({
      type: "conversation.item.create",
      item: { type: "function_call_output", call_id: id, output: JSON.stringify(output) },
    })
    projector.resolveWork(id).forEach(() => createResponse())
  }

  ws.addEventListener("open", () => {
    send(realtimeSessionUpdate(options))
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
    const result = projector.receive(String(event.data))
    if (options.debug || result.type !== "response.output_audio.delta")
      options.trace?.("realtime.receive", { type: result.type })
    const current = notification.current()
    const acknowledgement = current && result.event
      ? realtimeNotificationAcknowledgement(result.event, current.correlation)
      : undefined
    if (acknowledgement !== undefined && current) notification.settle(current.id, acknowledgement)
    result.events.forEach(options.onEvent)
    result.commands.forEach(() => createResponse())
  })
  ws.addEventListener("close", (event) => {
    if (closeTimer) clearTimeout(closeTimer)
    notification.close()
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
    notify(request) {
      const suffix = crypto.randomUUID().replaceAll("-", "")
      const itemID = `item_${suffix}`
      const eventID = `event_${suffix}`
      const pending = notification.begin(request.id, { itemID, eventID })
      if (!pending.started) return pending.promise
      const created = send({
        type: "conversation.item.create",
        event_id: eventID,
        item: { id: itemID, type: "message", role: "user", content: [{ type: "input_text", text: request.text }] },
      })
      if (!created || !createResponse()) {
        notification.settle(request.id, false)
        return Promise.resolve(false)
      }
      return pending.promise
    },
    interrupt() {
      send({ type: "response.cancel" })
    },
    close() {
      if (ws.readyState === WebSocket.CLOSED) return Promise.resolve()
      ws.close(1000)
      closeTimer ??= setTimeout(() => closed.resolve(), 5_000)
      return closed.promise
    },
  }
}
