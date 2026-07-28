import type { VoiceConnection, VoiceProtocol, VoiceProtocolEvent, VoiceProtocolOptions } from "./protocol"
import { decodeVoiceToolInput } from "./protocol"
import { Option, Schema } from "effect"

const LiveItem = Schema.Struct({
  id: Schema.String,
  type: Schema.String,
  text: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  call_id: Schema.optional(Schema.String),
  arguments: Schema.optional(Schema.String),
})
const LiveTurn = Schema.Struct({
  id: Schema.String,
  role: Schema.Literals(["user", "assistant"]),
  transcript: Schema.String,
})
const LiveEvent = Schema.Struct({
  type: Schema.String,
  audio: Schema.optional(Schema.String),
  delta: Schema.optional(Schema.String),
  start_ms: Schema.optional(Schema.Number),
  end_ms: Schema.optional(Schema.Number),
  turn_id: Schema.optional(Schema.String),
  turn: Schema.optional(LiveTurn),
  item: Schema.optional(LiveItem),
  error: Schema.optional(
    Schema.Struct({
      code: Schema.optional(Schema.String),
      message: Schema.optional(Schema.String),
    }),
  ),
})
const decodeLiveEvent = Schema.decodeUnknownOption(Schema.fromJsonString(LiveEvent))
type LiveTurn = Schema.Schema.Type<typeof LiveTurn>
type LiveEvent = Schema.Schema.Type<typeof LiveEvent>

type ProjectedTurn = LiveTurn & { readonly displayID: string }

export function createLiveEventProjector() {
  const turns = new Map<string, ProjectedTurn>()
  let input: { readonly id: string; readonly transcript: string } | undefined
  let assistantTranscript = ""
  const userTranscripts = new Map<string, { readonly text: string; readonly final: boolean }>()
  const startedTools = new Set<string>()

  const startTool = (item: LiveEvent["item"], events: VoiceProtocolEvent[]) => {
    if (item?.type !== "function_call" || !item.name || !item.call_id || startedTools.has(item.call_id)) return
    startedTools.add(item.call_id)
    events.push({ type: "tool.started", id: item.call_id, name: item.name })
  }

  const syncUser = (id: string, text: string, final: boolean, events: VoiceProtocolEvent[]) => {
    text = text.trimStart()
    const previous = userTranscripts.get(id)
    if (previous?.text === text && previous.final === final) return
    if (final) userTranscripts.delete(id)
    else userTranscripts.set(id, { text, final })
    events.push({ type: "user.transcript", id, text, final })
  }

  // Deltas are emitted verbatim, matching the Realtime adapter: a fragment's leading space is
  // the only record of the boundary between two assistant turns, so trimming it here would
  // weld the last word of one turn onto the first word of the next. Stripping the leading
  // edge of a rendered message is the consumer's job.
  const syncAssistant = (transcript: string, events: VoiceProtocolEvent[]) => {
    if (transcript.startsWith(assistantTranscript)) {
      const delta = transcript.slice(assistantTranscript.length)
      assistantTranscript = transcript
      if (delta) events.push({ type: "assistant.transcript.delta", delta })
      return
    }
    if (assistantTranscript.startsWith(transcript)) {
      assistantTranscript = transcript
      events.push({ type: "assistant.transcript", text: transcript })
      return
    }
    assistantTranscript = transcript
    events.push({ type: "assistant.transcript", text: transcript })
  }

  return (message: string) => {
    const data = Option.getOrUndefined(decodeLiveEvent(message))
    if (!data)
      return {
        type: undefined,
        events: [{ type: "error", message: "Received an invalid Live API event." }] satisfies VoiceProtocolEvent[],
      }

    const events: VoiceProtocolEvent[] = data.type.endsWith(".delta") ? [] : [{ type: "debug", message: data.type }]
    switch (data.type) {
      case "session.started":
        events.push({ type: "ready" })
        break
      case "output_audio.delta":
        if (data.audio && data.start_ms !== undefined && data.end_ms !== undefined)
          events.push({
            type: "assistant.audio",
            audio: Buffer.from(data.audio, "base64"),
            timeline: { startMs: data.start_ms, endMs: data.end_ms },
          })
        break
      case "input_transcript.added":
        if (data.item?.type !== "input_transcript" || data.item.text === undefined) break
        if (!input) {
          input = { id: data.item.id, transcript: "" }
          events.push({ type: "user.committed", id: input.id })
        }
        input = { ...input, transcript: input.transcript + data.item.text }
        syncUser(input.id, input.transcript, false, events)
        break
      case "output_transcript.added":
        if (data.item?.type !== "output_transcript" || data.item.text === undefined) break
        const delta = data.item.text
        assistantTranscript += delta
        if (delta) events.push({ type: "assistant.transcript.delta", delta })
        break
      case "turn.created": {
        const turn = data.turn
        if (!turn) break
        const displayID = turn.role === "user" ? (input?.id ?? turn.id) : turn.id
        turns.set(turn.id, { ...turn, displayID })
        if (turn.role === "user") {
          if (!input) events.push({ type: "user.committed", id: displayID })
          syncUser(displayID, turn.transcript, false, events)
          break
        }
        syncAssistant(turn.transcript, events)
        break
      }
      case "turn.delta": {
        if (!data.turn_id || !data.delta) break
        const turn = turns.get(data.turn_id)
        if (!turn) break
        const transcript = turn.transcript + data.delta
        turns.set(data.turn_id, { ...turn, transcript })
        if (turn.role === "user") {
          syncUser(turn.displayID, transcript, false, events)
          break
        }
        syncAssistant(transcript, events)
        break
      }
      case "turn.done": {
        const turn = data.turn
        if (!turn) break
        const previous = turns.get(turn.id)
        if (turn.role === "user") {
          const displayID = previous?.displayID ?? input?.id ?? turn.id
          if (!previous && !input) events.push({ type: "user.committed", id: displayID })
          syncUser(displayID, turn.transcript, true, events)
          input = undefined
          turns.delete(turn.id)
          break
        }
        syncAssistant(turn.transcript, events)
        assistantTranscript = ""
        turns.delete(turn.id)
        events.push({ type: "assistant.done", awaitingWork: false })
        break
      }
      case "response.output_item.added":
        startTool(data.item, events)
        break
      case "response.output_item.done": {
        if (data.item?.type !== "function_call" || !data.item.call_id) break
        const name = data.item.name ?? "tool"
        startTool(data.item, events)
        if (!data.item.name || data.item.arguments === undefined) {
          const output = { status: "error", message: "Malformed Live function call." }
          events.push({
            type: "work.rejected",
            request: { id: data.item.call_id, name, input: {} },
            output,
          })
          startedTools.delete(data.item.call_id)
          break
        }
        const input = Option.getOrUndefined(decodeVoiceToolInput(data.item.arguments))
        if (!input) {
          const output = { status: "error", message: `Invalid arguments for tool ${data.item.name}.` }
          events.push({ type: "error", message: `Received invalid arguments for Live tool ${data.item.name}.` })
          events.push({
            type: "work.rejected",
            request: { id: data.item.call_id, name, input: {} },
            output,
          })
          startedTools.delete(data.item.call_id)
          break
        }
        events.push({
          type: "work.requested",
          request: { id: data.item.call_id, name: data.item.name, input },
        })
        startedTools.delete(data.item.call_id)
        break
      }
      case "error":
        events.push({ type: "error", message: `${data.error?.code}: ${data.error?.message}` })
    }
    return { type: data.type, events }
  }
}

export function createLiveProtocol(): VoiceProtocol {
  return {
    name: "live",
    inputActivity: "local",
    supportsTextInput: false,
    connect: connectLive,
  }
}

function connectLive(options: VoiceProtocolOptions): VoiceConnection {
  const ws = new WebSocket(`wss://api.openai.com/v1/live?model=${options.model}`, {
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
      "OpenAI-Alpha": "quicksilver=v2",
    },
  } as unknown as string[])
  const closed = Promise.withResolvers<void>()
  let closeTimer: ReturnType<typeof setTimeout> | undefined
  let notification: PromiseWithResolvers<boolean> | undefined
  let notificationTimer: ReturnType<typeof setTimeout> | undefined
  const project = createLiveEventProjector()

  const settleNotification = (accepted: boolean) => {
    if (!notification) return
    if (notificationTimer) clearTimeout(notificationTimer)
    notificationTimer = undefined
    notification.resolve(accepted)
    notification = undefined
  }

  const send = (event: Record<string, unknown>) => {
    if (options.debug || event["type"] !== "input_audio.append")
      options.trace?.("live.send", {
        type: event["type"],
        delegationID: event["delegation_item_id"],
      })
    if (ws.readyState !== WebSocket.OPEN) return false
    ws.send(JSON.stringify(event))
    return true
  }

  ws.addEventListener("open", () => {
    send({
      type: "session.update",
      event_id: crypto.randomUUID(),
      session: {
        instructions: options.instructions,
        audio: { output: { voice: options.voice } },
        delegation: {
          type: "responses",
          responses: {
            model: options.delegationModel,
            instructions: options.delegationInstructions,
            tools: options.tools,
          },
        },
      },
    })
  })
  ws.addEventListener("message", (event) => {
    const result = project(String(event.data))
    if (options.debug || result.type !== "output_audio.delta") options.trace?.("live.receive", { type: result.type })
    if (result.type === "session.context.appended") settleNotification(true)
    result.events.forEach(options.onEvent)
    if (result.type === "session.closed") ws.close(1000)
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
        options.trace?.("live.audio.dropped", { bytes: audio.length, buffered: ws.bufferedAmount })
        return
      }
      send({ type: "input_audio.append", audio: audio.toString("base64") })
    },
    resolveWork(request, output) {
      send({
        type: "delegation.function_call_output.create",
        event_id: crypto.randomUUID(),
        item: { type: "function_call_output", call_id: request.id, output: JSON.stringify(output) },
      })
    },
    notify(text) {
      if (notification) return Promise.resolve(false)
      notification = Promise.withResolvers<boolean>()
      if (
        !send({
          type: "session.context.append",
          event_id: crypto.randomUUID(),
          content: [{ type: "input_text", text: notificationText(text) }],
        })
      ) {
        settleNotification(false)
        return Promise.resolve(false)
      }
      notificationTimer = setTimeout(() => settleNotification(false), 5_000)
      return notification.promise
    },
    interrupt() {
      return false
    },
    close(closeOptions) {
      if (ws.readyState === WebSocket.CLOSED) return Promise.resolve()
      if (closeOptions?.graceful === false || ws.readyState !== WebSocket.OPEN) {
        ws.close(1000)
        closeTimer = setTimeout(() => closed.resolve(), 5_000)
        return closed.promise
      }
      send({ type: "session.close", event_id: crypto.randomUUID() })
      closeTimer = setTimeout(() => {
        ws.close(1000)
        closed.resolve()
      }, 10_500)
      return closed.promise
    },
  }
}

function notificationText(output: unknown) {
  const text = String(output)
  return text.length > 1_600 ? text.slice(0, 1_600) + "..." : text
}
