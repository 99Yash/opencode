import type { AudioEvent, AudioSession } from "./audio-session"
import { openCodeAnnouncementText, type CompletionReceipt, type OpenCodeAnnouncement } from "./opencode-notification"
import { createNotificationRouter } from "./notification-router"
import type {
  VoiceConnection,
  VoiceDelegationRequest,
  VoiceProtocol,
  VoiceProtocolEvent,
  VoiceProtocolOptions,
  VoiceTool,
  VoiceToolExecution,
  VoiceWorkRequest,
} from "./protocol"
import type { VoiceUI } from "./ui"
import { initialVoiceState, transitionVoice, type VoiceCommand, type VoiceEvent } from "./voice-coordinator"

export type VoiceSession = {
  start(): void
  cycleVoice(): void
  interrupt(): void
  toggleMicrophone(): void
  toggleSpeaker(): void
  queueNotification(announcement: OpenCodeAnnouncement): void
  close(): Promise<void>
}

export function voiceControlTool(voices: ReadonlyArray<string>): VoiceTool {
  return {
    type: "function",
    name: "set_voice",
    description: "Change your speaking voice. Requires a brief reconnect and resets voice conversation memory.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: { voice: { type: "string", enum: voices } },
      required: ["voice"],
    },
  }
}

export function createVoiceSession(options: {
  readonly protocol: VoiceProtocol
  readonly connection: Omit<VoiceProtocolOptions, "voice" | "onEvent">
  readonly initialVoice: string
  readonly voices: ReadonlyArray<string>
  readonly text?: string
  readonly ui: VoiceUI
  readonly audio?: AudioSession
  readonly tools: {
    readonly execute: (name: string, input: Record<string, unknown>) => Promise<VoiceToolExecution>
    readonly acknowledge: (receipt: CompletionReceipt) => Promise<void>
    readonly close: () => Promise<void>
  }
  readonly delegate: (
    request: VoiceDelegationRequest,
    execute: (request: VoiceWorkRequest) => Promise<unknown>,
  ) => Promise<string>
  readonly trace?: (event: string, data?: Record<string, unknown>) => void
  readonly onClosed: () => void
}): VoiceSession {
  let state = initialVoiceState(options.initialVoice)
  let connection: VoiceConnection | undefined
  let closed = false
  let closePromise: Promise<void> | undefined
  let voiceTimer: ReturnType<typeof setTimeout> | undefined
  const notifications = createNotificationRouter((routed) => {
    options.trace?.("notification.queued", {
      type: routed.announcement.notification.type,
      promptID: routed.promptID,
      depth: state.notifications.length + 1,
    })
    dispatch({
      type: "notification.queued",
      notification: {
        id: crypto.randomUUID(),
        receipt: routed.announcement.receipt,
        promptID: routed.promptID,
        delegationID: routed.delegationID,
        text: openCodeAnnouncementText(routed.announcement.notification),
      },
    })
  })

  function dispatch(event: VoiceEvent) {
    const transition = transitionVoice(state, event)
    if (transition.state === state && transition.commands.length === 0) return
    state = transition.state
    options.trace?.("voice.transition", {
      input: event.type,
      connection: state.connection,
      conversation: state.conversation,
      assistant: state.assistant,
      userSpeaking: state.userSpeaking,
      tools: state.tools.size,
      notifications: state.notifications.length,
      commands: transition.commands.map((command) => command.type),
    })
    transition.commands.forEach(runCommand)
  }

  const setVoice = (voice: string) => {
    options.ui.setStatus({ voice })
    options.ui.meta(`[voice] switching to ${voice}…`)
    dispatch({ type: "voice.selected", voice })
  }

  const interruptDelivery = () => {
    if (state.delivery) dispatch({ type: "notification.interrupted", id: state.delivery.notification.id })
  }

  const reconnect = () => {
    if (closed) return
    options.audio?.flushPlayback()
    options.ui.assistantDone()
    const previous = connection
    connection = undefined
    const next = () => {
      if (!closed) connect()
    }
    if (!previous) return next()
    void previous.close({ graceful: false }).finally(next)
  }

  function runCommand(command: VoiceCommand) {
    if (command.type === "connection.reconnect") return reconnect()
    if (command.type === "assistant.interrupt") {
      connection?.interrupt?.()
      options.audio?.flushPlayback()
      options.ui.assistantDone()
      return
    }
    if (command.type === "assistant.finish") {
      if (options.text) {
        options.ui.assistantDone()
        if (command.notificationID) dispatch({ type: "notification.announced", id: command.notificationID })
        if (!command.awaitingWork && state.tools.size === 0) options.onClosed()
        return
      }
      void options.audio?.finishPlayback().then((outcome) => {
        options.ui.assistantDone()
        if (!command.notificationID) return
        dispatch({
          type: outcome === "played" ? "notification.announced" : "notification.interrupted",
          id: command.notificationID,
        })
      })
      return
    }
    if (command.type === "notification.delivered") {
      options.trace?.("notification.announced", {
        id: command.notification.id,
        promptID: command.notification.promptID,
      })
      if (!command.notification.receipt) return
      const receipt = command.notification.receipt
      void options.tools
        .acknowledge(receipt)
        .catch((error) =>
          options.trace?.("notification.ack.failed", { id: command.notification.id, error: String(error) }),
        )
        .finally(() => notifications.acknowledged(receipt))
      return
    }
    const active = connection
    if (!active) return dispatch({ type: "notification.failed", id: command.notification.id })
    void active
      .notify({
        id: command.notification.id,
        text: `Announce this OpenCode update conversationally without reading private identifiers aloud:\n${command.notification.text}`,
        delegationID: command.notification.delegationID,
      })
      .then((accepted) => {
        if (!accepted) return dispatch({ type: "notification.failed", id: command.notification.id })
        dispatch({ type: "notification.accepted", id: command.notification.id })
        options.trace?.("notification.context.accepted", {
          id: command.notification.id,
          promptID: command.notification.promptID,
          remaining: state.notifications.length,
        })
      })
      .catch((error) => {
        options.trace?.("notification.context.failed", {
          id: command.notification.id,
          promptID: command.notification.promptID,
          error: String(error),
        })
        dispatch({ type: "notification.failed", id: command.notification.id })
      })
  }

  const executeTool = async (request: VoiceWorkRequest, delegationID?: string) => {
    if (delegationID) notifications.beginDelegatedTool()
    const execution: VoiceToolExecution = await (request.name === "set_voice"
      ? Promise.resolve().then(() => {
          const voice = request.input["voice"]
          if (typeof voice !== "string" || !options.voices.includes(voice))
            return { output: toolError(`Voice must be one of: ${options.voices.join(", ")}.`) }
          if (voiceTimer) clearTimeout(voiceTimer)
          voiceTimer = setTimeout(() => {
            voiceTimer = undefined
            setVoice(voice)
          }, 1_000)
          return {
            output: {
              status: "switching",
              voice,
              note: `${options.protocol.name} conversation memory resets during reconnect.`,
            },
          }
        })
      : options.tools
          .execute(request.name, request.input)
          .catch((error) => ({ output: toolError(String(error), true) } satisfies VoiceToolExecution)))
    options.ui.toolDone(request.id, execution.output)
    if (delegationID) notifications.finishDelegatedTool(delegationID, execution.admittedPrompt)
    return execution.output
  }

  const queueWork = (source: VoiceConnection, request: VoiceWorkRequest) => {
    options.trace?.("work.started", { id: request.id, name: request.name })
    void executeTool(request)
      .then((output) => {
        options.trace?.("work.resolved", { id: request.id, name: request.name })
        source.resolveWork(request, output)
      })
      .catch((error) => options.ui.meta(`[work error] ${String(error)}`))
      .finally(() => dispatch({ type: "tool.finished", id: request.id }))
  }

  const userSpeaking = (active: boolean) => {
    if (active === state.userSpeaking) return
    dispatch(
      active
        ? { type: "user.started", bargeIn: options.audio?.fullDuplex && options.protocol.capabilities.interruption }
        : { type: "user.stopped" },
    )
    options.ui.userSpeaking(active)
  }

  const onAudioEvent = (event: AudioEvent) => {
    switch (event.type) {
      case "input":
        connection?.appendAudio(event.audio)
        options.ui.userAudioLevel(event.level)
        return
      case "user.started":
        userSpeaking(true)
        return
      case "user.stopped":
        userSpeaking(false)
        return
      case "user.reset":
        options.ui.userReset()
        return
      case "assistant.level":
        options.ui.assistantAudio(event.level, event.durationMs)
        return
      case "status":
        options.ui.setStatus({ audio: event.audio })
        return
      case "meta":
        options.ui.meta(event.text)
    }
  }

  const onProtocolEvent = (source: VoiceConnection, event: VoiceProtocolEvent) => {
    if (source !== connection || closed) return
    if (options.connection.debug || event.type !== "assistant.audio")
      options.trace?.("protocol.event", {
        type: event.type,
        conversation: state.conversation,
        assistant: state.assistant,
        userSpeaking: state.userSpeaking,
        pendingWork: state.tools.size,
      })
    switch (event.type) {
      case "ready":
        dispatch({ type: "connection.ready" })
        options.ui.meta(
          `connected to ${options.protocol.name} ${options.connection.model} (voice: ${state.desiredVoice})`,
        )
        options.ui.setStatus({
          voice: state.desiredVoice,
          microphoneMuted: options.audio?.microphoneMuted,
          speakerMuted: options.audio?.speakerMuted,
        })
        if (!options.text) {
          void options.audio?.start(onAudioEvent)
          return
        }
        options.ui.userTranscript("typed", options.text)
        dispatch({ type: "user.committed" })
        source.sendText?.(options.text)
        return
      case "user.started":
        userSpeaking(true)
        return
      case "user.stopped":
        userSpeaking(false)
        return
      case "user.committed":
        options.audio?.noteUserCommitted()
        dispatch({ type: "user.committed" })
        options.ui.userCommitted(event.id)
        return
      case "user.transcript":
        options.audio?.noteUserTranscript(event.final)
        if (event.final) {
          dispatch({ type: "user.stopped" })
          options.ui.userSpeaking(false)
        }
        options.ui.userTranscript(event.id, event.text, event.final)
        return
      case "assistant.audio":
        if (state.assistant === "suppressed") return
        dispatch({ type: "assistant.started" })
        options.audio?.play(event.audio, event.timeline)
        return
      case "assistant.transcript.delta":
        if (state.assistant === "suppressed") return
        dispatch({ type: "assistant.started" })
        options.ui.assistantDelta(event.delta)
        return
      case "assistant.transcript":
        if (state.assistant === "suppressed") return
        dispatch({ type: "assistant.started" })
        options.ui.assistantTranscript(event.text)
        return
      case "assistant.done": {
        dispatch({ type: "assistant.done", awaitingWork: event.awaitingWork })
        return
      }
      case "tool.started":
        dispatch({ type: "tool.started", id: event.id })
        options.ui.toolStart(event.id, event.name, {})
        return
      case "work.requested":
        queueWork(source, event.request)
        return
      case "work.rejected":
        dispatch({ type: "tool.started", id: event.request.id })
        options.ui.toolStart(event.request.id, event.request.name, event.request.input)
        options.ui.toolDone(event.request.id, event.output)
        source.resolveWork(event.request, event.output)
        dispatch({ type: "tool.finished", id: event.request.id })
        return
      case "delegation.requested":
        dispatch({ type: "tool.started", id: event.request.id })
        void options
          .delegate(event.request, (request) => {
            options.ui.toolStart(request.id, request.name, request.input)
            return executeTool(request, event.request.id)
          })
          .then((output) => {
            if (source !== connection) {
              options.trace?.("delegation.result.stale", { id: event.request.id })
              return
            }
            source.resolveDelegation?.(event.request, output)
          })
          .catch((error) => {
            options.trace?.("responses.controller.failed", { error: String(error) })
            if (source !== connection) return
            options.ui.toolStart(event.request.id, "opencode", { text: event.request.text })
            options.ui.toolDone(event.request.id, { status: "error", message: String(error) })
            source.resolveDelegation?.(event.request, `The OpenCode controller failed: ${String(error)}`)
          })
          .finally(() => dispatch({ type: "tool.finished", id: event.request.id }))
        return
      case "debug":
        if (options.connection.debug) options.ui.meta(`[debug] ${event.message}`)
        return
      case "error":
        options.ui.meta(`[${options.protocol.name} error] ${event.message}`)
        return
      case "closed":
        dispatch({ type: "connection.closed" })
        options.ui.meta(`${options.protocol.name} connection closed (${event.code})`)
        options.onClosed()
    }
  }

  const connect = () => {
    let next: VoiceConnection
    next = options.protocol.connect({
      ...options.connection,
      voice: state.desiredVoice,
      onEvent: (event) => onProtocolEvent(next, event),
    })
    dispatch({ type: "connection.connecting" })
    connection = next
  }

  const session: VoiceSession = {
    start: connect,
    cycleVoice() {
      setVoice(options.voices[(options.voices.indexOf(state.desiredVoice) + 1) % options.voices.length])
    },
    interrupt() {
      if (!options.audio?.isPlaying() && state.assistant === "idle") return
      if (state.assistant === "active") {
        connection?.interrupt?.()
        dispatch({ type: "assistant.suppressed" })
      }
      interruptDelivery()
      options.audio?.flushPlayback()
      options.ui.assistantDone()
      options.ui.meta("[interrupted]")
    },
    toggleMicrophone() {
      if (!options.audio) return
      const muted = options.audio.toggleMicrophone()
      userSpeaking(false)
      options.ui.setStatus({ microphoneMuted: muted })
      if (muted) options.ui.userReset()
      options.ui.userAudioLevel(undefined)
      options.ui.meta(`[microphone] ${muted ? "muted" : "live"}`)
    },
    toggleSpeaker() {
      if (!options.audio) return
      const muted = options.audio.toggleSpeaker()
      options.ui.setStatus({ speakerMuted: muted })
      if (muted) options.ui.assistantPlaybackStopped()
      options.ui.meta(`[speaker] ${muted ? "muted" : "live"}`)
    },
    queueNotification(announcement) {
      notifications.route(announcement)
    },
    close() {
      if (closePromise) return closePromise
      closed = true
      if (voiceTimer) clearTimeout(voiceTimer)
      options.audio?.close()
      const active = connection
      connection = undefined
      dispatch({ type: "connection.closed" })
      closePromise = Promise.allSettled([options.tools.close(), ...(active ? [active.close()] : [])]).then(() => {})
      return closePromise
    },
  }
  return session
}

function toolError(message: string, retryable = false) {
  return { status: "error", message, retryable }
}
