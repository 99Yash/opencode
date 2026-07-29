import type { CompletionReceipt } from "./opencode-notification"

export type VoiceNotification = {
  readonly id: string
  readonly receipt?: CompletionReceipt
  readonly promptID?: string
  readonly delegationID?: string
  readonly text: string
}

export type VoiceState = {
  readonly connection: "connecting" | "ready" | "closed"
  readonly conversation: "idle" | "waiting" | "responding"
  readonly assistant: "idle" | "active" | "suppressed"
  readonly userSpeaking: boolean
  readonly tools: ReadonlySet<string>
  readonly notifications: ReadonlyArray<VoiceNotification>
  readonly delivery?: {
    readonly notification: VoiceNotification
    readonly phase: "sending" | "accepted" | "announcing" | "awaiting-playback"
  }
  readonly desiredVoice: string
  readonly reconnect: "none" | "pending"
}

export type VoiceEvent =
  | { readonly type: "connection.ready" }
  | { readonly type: "connection.connecting" }
  | { readonly type: "connection.closed" }
  | { readonly type: "user.started"; readonly bargeIn?: boolean }
  | { readonly type: "user.stopped" }
  | { readonly type: "user.committed" }
  | { readonly type: "assistant.started" }
  | { readonly type: "assistant.suppressed" }
  | { readonly type: "assistant.done"; readonly awaitingWork: boolean }
  | { readonly type: "tool.started"; readonly id: string }
  | { readonly type: "tool.finished"; readonly id: string }
  | { readonly type: "notification.queued"; readonly notification: VoiceNotification }
  | { readonly type: "notification.accepted"; readonly id: string }
  | { readonly type: "notification.failed"; readonly id: string }
  | { readonly type: "notification.announced"; readonly id: string }
  | { readonly type: "notification.interrupted"; readonly id: string }
  | { readonly type: "voice.selected"; readonly voice: string }

export type VoiceCommand =
  | { readonly type: "notification.send"; readonly notification: VoiceNotification }
  | { readonly type: "notification.delivered"; readonly notification: VoiceNotification }
  | { readonly type: "assistant.finish"; readonly awaitingWork: boolean; readonly notificationID?: string }
  | { readonly type: "assistant.interrupt" }
  | { readonly type: "connection.reconnect" }

export type VoiceTransition = {
  readonly state: VoiceState
  readonly commands: ReadonlyArray<VoiceCommand>
}

export function initialVoiceState(voice: string): VoiceState {
  return {
    connection: "connecting",
    conversation: "idle",
    assistant: "idle",
    userSpeaking: false,
    tools: new Set(),
    notifications: [],
    desiredVoice: voice,
    reconnect: "none",
  }
}

export function transitionVoice(state: VoiceState, event: VoiceEvent): VoiceTransition {
  if (event.type === "notification.announced") {
    if (state.delivery?.notification.id !== event.id || state.delivery.phase !== "awaiting-playback")
      return { state, commands: [] }
    const notification = state.delivery.notification
    const next = settle({ ...state, delivery: undefined })
    return {
      state: next.state,
      commands: [{ type: "notification.delivered", notification }, ...next.commands],
    }
  }
  if (event.type === "assistant.done") {
    const notificationID =
      state.delivery?.phase === "announcing" && state.assistant === "active" && !event.awaitingWork
        ? state.delivery.notification.id
        : undefined
    const next = settle(reduce(state, event))
    return {
      state: next.state,
      commands: [{ type: "assistant.finish", awaitingWork: event.awaitingWork, notificationID }, ...next.commands],
    }
  }
  if (event.type === "user.started" && event.bargeIn && state.assistant === "active") {
    const next = settle(
      state.delivery
        ? {
            ...state,
            conversation: "idle",
            assistant: "idle",
            userSpeaking: true,
            delivery: undefined,
            notifications: [state.delivery.notification, ...state.notifications],
            reconnect: "pending",
          }
        : { ...state, assistant: "suppressed", userSpeaking: true },
    )
    return { state: next.state, commands: [{ type: "assistant.interrupt" }, ...next.commands] }
  }
  const next = reduce(state, event)
  return settle(next)
}

function reduce(state: VoiceState, event: VoiceEvent): VoiceState {
  switch (event.type) {
    case "connection.ready":
      if (state.connection === "ready") return state
      return { ...state, connection: "ready" }
    case "connection.connecting":
      return {
        ...state,
        connection: "connecting",
        conversation: "idle",
        assistant: "idle",
        userSpeaking: false,
      }
    case "connection.closed":
      return { ...state, connection: "closed", conversation: "idle", assistant: "idle", userSpeaking: false }
    case "user.started":
      if (state.userSpeaking) return state
      return { ...state, userSpeaking: true }
    case "user.stopped":
      if (!state.userSpeaking) return state
      return { ...state, userSpeaking: false }
    case "user.committed":
      return {
        ...state,
        userSpeaking: false,
        conversation: state.assistant === "active" ? "responding" : "waiting",
        assistant: state.assistant === "suppressed" ? "idle" : state.assistant,
      }
    case "assistant.started":
      if (state.assistant === "suppressed" || state.assistant === "active") return state
      return {
        ...state,
        conversation: "responding",
        assistant: "active",
        delivery:
          state.delivery?.phase === "accepted" ? { ...state.delivery, phase: "announcing" } : state.delivery,
      }
    case "assistant.suppressed":
      return { ...state, assistant: "suppressed" }
    case "assistant.done":
      return {
        ...state,
        conversation: event.awaitingWork ? "waiting" : "idle",
        assistant: "idle",
        delivery:
          state.delivery?.phase === "announcing" && state.assistant === "active" && !event.awaitingWork
            ? { ...state.delivery, phase: "awaiting-playback" }
            : state.delivery,
      }
    case "tool.started":
      if (state.tools.has(event.id)) return state
      return { ...state, conversation: "waiting", tools: new Set([...state.tools, event.id]) }
    case "tool.finished": {
      if (!state.tools.has(event.id)) return state
      const tools = new Set(state.tools)
      tools.delete(event.id)
      return { ...state, tools }
    }
    case "notification.queued":
      return { ...state, notifications: [...state.notifications, event.notification] }
    case "notification.accepted":
      if (state.delivery?.notification.id !== event.id || state.delivery.phase !== "sending") return state
      return {
        ...state,
        delivery: { ...state.delivery, phase: "accepted" },
      }
    case "notification.failed":
      if (state.delivery?.notification.id !== event.id) return state
      return {
        ...state,
        connection: "ready",
        conversation: "idle",
        delivery: undefined,
        notifications: [state.delivery.notification, ...state.notifications],
        reconnect: "pending",
      }
    case "notification.announced":
      return state
    case "notification.interrupted":
      if (state.delivery?.notification.id !== event.id) return state
      return {
        ...state,
        conversation: "idle",
        assistant: "idle",
        delivery: undefined,
        notifications: [state.delivery.notification, ...state.notifications],
        reconnect: "pending",
      }
    case "voice.selected":
      if (event.voice === state.desiredVoice) return state
      return { ...state, desiredVoice: event.voice, reconnect: "pending" }
  }
  return state
}

function settle(state: VoiceState): VoiceTransition {
  if (
    state.reconnect === "pending" &&
    state.connection === "ready" &&
    state.conversation === "idle" &&
    state.delivery === undefined &&
    !state.userSpeaking &&
    state.tools.size === 0
  )
    return {
      state: { ...state, connection: "connecting", reconnect: "none" },
      commands: [{ type: "connection.reconnect" }],
    }

  if (
    state.notifications.length > 0 &&
    state.delivery === undefined &&
    state.connection === "ready" &&
    state.conversation === "idle" &&
    !state.userSpeaking &&
    state.tools.size === 0
  ) {
    const notification = state.notifications[0]
    return {
      state: {
        ...state,
        conversation: "waiting",
        delivery: { notification, phase: "sending" },
        notifications: state.notifications.slice(1),
      },
      commands: [{ type: "notification.send", notification }],
    }
  }

  return { state, commands: [] }
}
