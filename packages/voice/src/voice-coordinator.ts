export type VoiceNotification = {
  readonly promptID?: string
  readonly text: string
}

export type VoiceState = {
  readonly connection: "connecting" | "ready" | "closed"
  readonly conversation: "idle" | "waiting" | "responding"
  readonly assistant: "idle" | "active" | "suppressed"
  readonly userSpeaking: boolean
  readonly tools: ReadonlySet<string>
  readonly notifications: ReadonlyArray<VoiceNotification>
  readonly desiredVoice: string
  readonly reconnect: "none" | "pending"
}

export type VoiceEvent =
  | { readonly type: "connection.ready" }
  | { readonly type: "connection.connecting" }
  | { readonly type: "connection.closed" }
  | { readonly type: "user.started" }
  | { readonly type: "user.stopped" }
  | { readonly type: "user.committed" }
  | { readonly type: "assistant.started" }
  | { readonly type: "assistant.suppressed" }
  | { readonly type: "assistant.done"; readonly awaitingWork: boolean }
  | { readonly type: "tool.started"; readonly id: string }
  | { readonly type: "tool.finished"; readonly id: string }
  | { readonly type: "notification.queued"; readonly notification: VoiceNotification }
  | { readonly type: "notification.failed"; readonly notification: VoiceNotification }
  | { readonly type: "voice.selected"; readonly voice: string }

export type VoiceCommand =
  | { readonly type: "notification.send"; readonly notification: VoiceNotification }
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
      return { ...state, userSpeaking: false, conversation: "waiting", assistant: "idle" }
    case "assistant.started":
      if (state.assistant === "suppressed" || state.assistant === "active") return state
      return { ...state, conversation: "responding", assistant: "active" }
    case "assistant.suppressed":
      return { ...state, assistant: "suppressed" }
    case "assistant.done":
      return {
        ...state,
        conversation: event.awaitingWork ? "waiting" : "idle",
        assistant: "idle",
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
    case "notification.failed":
      return {
        ...state,
        connection: "ready",
        conversation: "idle",
        notifications: [event.notification, ...state.notifications],
        reconnect: "pending",
      }
    case "voice.selected":
      if (event.voice === state.desiredVoice) return state
      return { ...state, desiredVoice: event.voice, reconnect: "pending" }
  }
}

function settle(state: VoiceState): VoiceTransition {
  if (
    state.reconnect === "pending" &&
    state.connection === "ready" &&
    state.conversation === "idle" &&
    state.tools.size === 0
  )
    return {
      state: { ...state, connection: "connecting", reconnect: "none" },
      commands: [{ type: "connection.reconnect" }],
    }

  if (
    state.notifications.length > 0 &&
    state.connection === "ready" &&
    state.conversation === "idle" &&
    !state.userSpeaking &&
    state.tools.size === 0
  ) {
    const notification = state.notifications[0]
    return {
      state: { ...state, conversation: "waiting", notifications: state.notifications.slice(1) },
      commands: [{ type: "notification.send", notification }],
    }
  }

  return { state, commands: [] }
}
