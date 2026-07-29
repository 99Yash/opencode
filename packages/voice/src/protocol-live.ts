import type {
  VoiceConnection,
  VoiceDelegationRequest,
  VoiceNotificationRequest,
  VoiceProtocol,
  VoiceProtocolEvent,
  VoiceProtocolOptions,
} from "./protocol"
import { decodeVoiceToolInput } from "./protocol"
import { Option, Schema } from "effect"

const LiveItem = Schema.Struct({
  id: Schema.String,
  type: Schema.String,
  text: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  call_id: Schema.optional(Schema.String),
  arguments: Schema.optional(Schema.String),
  target: Schema.optional(Schema.String),
  content: Schema.optional(Schema.Array(Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) }))),
})
const LiveTurn = Schema.Struct({
  id: Schema.String,
  role: Schema.Literals(["user", "assistant"]),
  transcript: Schema.String,
})
const LiveEvent = Schema.Struct({
  type: Schema.String,
  event_id: Schema.optional(Schema.String),
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
      event_id: Schema.optional(Schema.String),
    }),
  ),
})
const decodeLiveEvent = Schema.decodeUnknownOption(Schema.fromJsonString(LiveEvent))
type LiveTurn = Schema.Schema.Type<typeof LiveTurn>
type LiveEvent = Schema.Schema.Type<typeof LiveEvent>

type LiveNotificationResult = {
  readonly type?: string
  readonly eventID?: string
  readonly errorEventID?: string
}

export function liveNotificationAcknowledgement(
  result: LiveNotificationResult,
  pending: {
    readonly eventID: string
    readonly acknowledgement: "session.context.appended" | "delegation.context.appended"
  },
) {
  // Live success events do not reliably echo the client event ID. Context
  // appends are serialized, so the expected acknowledgement kind is the
  // strongest correlation the protocol currently provides.
  if (result.type === pending.acknowledgement) return true
  if (result.type === "error" && result.errorEventID === pending.eventID) return false
  return undefined
}

type ProjectedTurn = LiveTurn & { readonly displayID: string }

export function createLiveEventProjector() {
  const turns = new Map<string, ProjectedTurn>()
  let input: { readonly id: string; readonly transcript: string } | undefined
  let assistantTranscript = ""
  const userTranscripts = new Map<string, string>()
  const startedTools = new Set<string>()

  const startTool = (item: LiveEvent["item"], events: VoiceProtocolEvent[]) => {
    if (item?.type !== "function_call" || !item.name || !item.call_id || startedTools.has(item.call_id)) return
    startedTools.add(item.call_id)
    events.push({ type: "tool.started", id: item.call_id, name: item.name })
  }

  const syncUser = (id: string, text: string, final: boolean, events: VoiceProtocolEvent[]) => {
    text = text.trimStart()
    const previous = userTranscripts.get(id)
    if (previous === text && !final) return
    if (final) userTranscripts.delete(id)
    else userTranscripts.set(id, text)
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
      case "delegation.created":
        if (data.item?.type !== "delegation" || data.item.target !== "client") break
        events.push({
          type: "delegation.requested",
          request: {
            id: data.item.id,
            text:
              data.item.content
                ?.flatMap((part) => (part.type === "input_text" && part.text ? [part.text] : []))
                .join("\n") ?? "",
          },
        })
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
    return {
      type: data.type,
      eventID: data.event_id,
      errorEventID: data.error?.event_id,
      events,
    }
  }
}

export function createLiveProtocol(): VoiceProtocol {
  return {
    name: "live",
    inputActivity: "local",
    capabilities: { textInput: false, interruption: false, delegation: true },
    connect: connectLive,
  }
}

export function createLiveEventDelivery(options: {
  readonly emit: (event: VoiceProtocolEvent) => void
  readonly drainMs?: number
}) {
  let pendingDone: Extract<VoiceProtocolEvent, { readonly type: "assistant.done" }> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined

  const schedule = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      const event = pendingDone
      pendingDone = undefined
      if (event) options.emit(event)
    }, options.drainMs ?? 120)
  }

  return {
    push(event: VoiceProtocolEvent) {
      if (event.type === "assistant.done") {
        pendingDone = event
        schedule()
        return
      }
      if (event.type === "assistant.audio" && pendingDone) schedule()
      options.emit(event)
    },
    close() {
      if (timer) clearTimeout(timer)
      timer = undefined
      pendingDone = undefined
    },
  }
}

export function createLiveContextAppendQueue(options: {
  readonly send: (event: Record<string, unknown>) => boolean
  readonly timeoutMs?: number
}) {
  type Item = {
    readonly event: Record<string, unknown>
    readonly acknowledgement: "session.context.appended" | "delegation.context.appended"
    readonly result: PromiseWithResolvers<boolean>
  }
  const queued: Item[] = []
  let active: (Item & { readonly timer: ReturnType<typeof setTimeout> }) | undefined
  let closed = false

  const settle = (accepted: boolean) => {
    if (!active) return
    clearTimeout(active.timer)
    active.result.resolve(accepted)
    active = undefined
    pump()
  }

  const pump = () => {
    if (closed || active) return
    const item = queued.shift()
    if (!item) return
    active = {
      ...item,
      timer: setTimeout(() => settle(false), options.timeoutMs ?? 5_000),
    }
    if (!options.send(item.event)) settle(false)
  }

  return {
    append(
      event: Record<string, unknown>,
      acknowledgement: "session.context.appended" | "delegation.context.appended",
    ) {
      if (closed) return Promise.resolve(false)
      const result = Promise.withResolvers<boolean>()
      queued.push({ event, acknowledgement, result })
      pump()
      return result.promise
    },
    receive(result: LiveNotificationResult) {
      if (!active) return
      const eventID = active.event["event_id"]
      const accepted = liveNotificationAcknowledgement(result, {
        eventID: typeof eventID === "string" ? eventID : "",
        acknowledgement: active.acknowledgement,
      })
      if (accepted !== undefined) settle(accepted)
    },
    close() {
      closed = true
      if (active) {
        clearTimeout(active.timer)
        active.result.resolve(false)
        active = undefined
      }
      queued.splice(0).forEach((item) => item.result.resolve(false))
    },
  }
}

function connectLive(options: VoiceProtocolOptions): VoiceConnection {
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- Bun accepts WebSocket headers in this runtime-only overload.
  const ws = new WebSocket(`wss://api.openai.com/v1/live?model=${options.model}`, {
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
      "OpenAI-Alpha": "quicksilver=v2",
    },
  } as unknown as string[])
  const closed = Promise.withResolvers<void>()
  let closeTimer: ReturnType<typeof setTimeout> | undefined
  const project = createLiveEventProjector()
  const delivery = createLiveEventDelivery({ emit: options.onEvent })

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
  const context = createLiveContextAppendQueue({ send })

  const appendNotification = (request: VoiceNotificationRequest) =>
    context.append(
      {
        type: "session.context.append",
        event_id: crypto.randomUUID(),
        content: [{ type: "input_text", text: notificationText(request.text) }],
      },
      "session.context.appended",
    )

  ws.addEventListener("open", () => {
    send({
      type: "session.update",
      event_id: crypto.randomUUID(),
      session: {
        instructions: options.instructions,
        audio: { output: { voice: options.voice } },
        delegation: { type: "client" },
      },
    })
  })
  ws.addEventListener("message", (event) => {
    const result = project(String(event.data))
    if (options.debug || result.type !== "output_audio.delta") options.trace?.("live.receive", { type: result.type })
    context.receive(result)
    result.events.forEach((event) => {
      if (event.type === "assistant.audio")
        options.trace?.("live.audio.received", {
          bytes: event.audio.length,
          startMs: event.timeline?.startMs,
          endMs: event.timeline?.endMs,
        })
      delivery.push(event)
    })
    if (result.type === "session.closed") ws.close(1000)
  })
  ws.addEventListener("close", (event) => {
    if (closeTimer) clearTimeout(closeTimer)
    context.close()
    delivery.close()
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
    resolveDelegation(request: VoiceDelegationRequest, output: string) {
      void context
        .append(delegationContext(crypto.randomUUID(), request.id, output), "delegation.context.appended")
        .then((accepted) => {
          if (!accepted) options.trace?.("live.delegation.context.failed", { delegationID: request.id })
        })
    },
    notify(request) {
      return appendNotification(request)
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

function delegationContext(eventID: string, delegationID: string, text: string) {
  return {
    type: "delegation.context.append",
    event_id: eventID,
    delegation_item_id: delegationID,
    content: [{ type: "input_text", text: notificationText(text) }],
  }
}

function notificationText(output: unknown) {
  const text = String(output)
  return text.length > 1_600 ? text.slice(0, 1_600) + "..." : text
}
