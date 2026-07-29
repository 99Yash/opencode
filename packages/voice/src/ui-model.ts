import { REVEAL_WORD_LIMIT, scheduleTextReveal, type TextReveal } from "./animation"

export type Message =
  | {
      readonly key: string
      readonly kind: "user"
      readonly itemID: string
      readonly text?: string
      readonly transcribing: boolean
      readonly reveals: ReadonlyArray<TextReveal>
    }
  | {
      readonly key: string
      readonly kind: "assistant"
      readonly text: string
      readonly streaming: boolean
      readonly reveals: ReadonlyArray<TextReveal>
    }
  | {
      readonly key: string
      readonly kind: "tool"
      readonly callID: string
      readonly name: string
      readonly input: unknown
      readonly output?: unknown
    }
  | { readonly key: string; readonly kind: "meta"; readonly text: string }

type NewMessage = Message extends infer Item ? (Item extends Message ? Omit<Item, "key"> : never) : never

export type VoiceViewState = {
  readonly messages: ReadonlyArray<Message>
  readonly messageSequence: number
  readonly activeUserID?: string
  readonly userSequence: number
  readonly revealAt: number
  readonly revealAnimationEndsAt: number
}

export type VoiceViewEvent =
  | { readonly type: "meta"; readonly text: string }
  | { readonly type: "user.started" }
  | { readonly type: "user.reset" }
  | { readonly type: "user.committed"; readonly itemID: string }
  | {
      readonly type: "user.transcript"
      readonly itemID: string
      readonly text: string
      readonly final: boolean
      readonly now: number
      readonly animate: boolean
    }
  | { readonly type: "assistant.delta"; readonly text: string; readonly now: number; readonly animate: boolean }
  | { readonly type: "assistant.transcript"; readonly text: string; readonly now: number; readonly animate: boolean }
  | { readonly type: "assistant.done" }
  | { readonly type: "tool.started"; readonly callID: string; readonly name: string; readonly input: unknown }
  | { readonly type: "tool.done"; readonly callID: string; readonly output: unknown }
  | { readonly type: "reveals.completed" }

const MESSAGE_LIMIT = 200

export function initialVoiceView(): VoiceViewState {
  return { messages: [], messageSequence: 0, userSequence: 0, revealAt: 0, revealAnimationEndsAt: 0 }
}

export function transitionVoiceView(state: VoiceViewState, event: VoiceViewEvent): VoiceViewState {
  switch (event.type) {
    case "meta":
      return append(state, { kind: "meta", text: event.text })
    case "user.started": {
      if (state.activeUserID) return state
      const itemID = `local-user-${state.userSequence + 1}`
      return { ...state, activeUserID: itemID, userSequence: state.userSequence + 1 }
    }
    case "user.reset": {
      if (!state.activeUserID) return state
      return {
        ...state,
        activeUserID: undefined,
        messages: mergeAssistantRows(state.messages),
      }
    }
    case "user.committed": {
      const index = state.activeUserID
        ? state.messages.findIndex((message) => message.kind === "user" && message.itemID === state.activeUserID)
        : -1
      const current = {
        ...state,
        activeUserID: undefined,
        messages: state.messages.map((message, currentIndex) => {
          if (message.kind === "assistant" && message.streaming) return { ...message, streaming: false }
          if (currentIndex === index && message.kind === "user") return { ...message, itemID: event.itemID }
          return message
        }),
      }
      if (index !== -1) return current
      return append(current, { kind: "user", itemID: event.itemID, transcribing: true, reveals: [] })
    }
    case "user.transcript": {
      const index = state.messages.findIndex((message) => message.kind === "user" && message.itemID === event.itemID)
      if (index === -1) {
        const revealed = reveal(state, "", event.text, event.now, event.animate)
        return append(revealed.state, {
          kind: "user",
          itemID: event.itemID,
          text: event.text,
          transcribing: !event.final,
          reveals: revealed.reveals,
        })
      }
      const previous = state.messages[index]
      if (previous.kind !== "user") return state
      const previousText = previous.text ?? ""
      if (previousText === event.text && previous.transcribing === !event.final) return state
      const appended = event.text.startsWith(previousText)
      const revealed = reveal(
        state,
        appended ? previousText : "",
        appended ? event.text.slice(previousText.length) : event.text,
        event.now,
        event.animate,
      )
      return {
        ...revealed.state,
        messages: state.messages.map((message, currentIndex) =>
          currentIndex === index && message.kind === "user"
            ? {
                ...message,
                text: event.text,
                transcribing: !event.final,
                reveals: appended
                  ? [...message.reveals, ...revealed.reveals].slice(-REVEAL_WORD_LIMIT)
                  : revealed.reveals,
              }
            : message,
        ),
      }
    }
    case "assistant.delta": {
      const streaming = state.messages.findLastIndex((message) => message.kind === "assistant" && message.streaming)
      const lastIndex = state.messages.length - 1
      const index = streaming === -1 && state.messages[lastIndex]?.kind === "assistant" ? lastIndex : streaming
      const message = state.messages[index]
      if (message?.kind !== "assistant") {
        const text = event.text.trimStart()
        const revealed = reveal(state, "", text, event.now, event.animate)
        return append(
          {
            ...revealed.state,
            messages: state.messages.map((message) =>
              message.kind === "assistant" && message.streaming ? { ...message, streaming: false } : message,
            ),
          },
          { kind: "assistant", text, streaming: true, reveals: revealed.reveals },
        )
      }
      const joined =
        streaming === -1
          ? joinAssistantText(message.text, event.text)
          : { text: message.text + event.text, previous: message.text, appended: event.text }
      const revealed = reveal(state, joined.previous, joined.appended, event.now, event.animate)
      return {
        ...revealed.state,
        messages: state.messages.map((message, currentIndex) =>
          currentIndex === index && message.kind === "assistant"
            ? {
                ...message,
                text: joined.text,
                streaming: true,
                reveals: [...message.reveals, ...revealed.reveals].slice(-REVEAL_WORD_LIMIT),
              }
            : message,
        ),
      }
    }
    case "assistant.transcript": {
      const text = event.text.trimStart()
      const index = state.messages.findLastIndex((message) => message.kind === "assistant" && message.streaming)
      if (index === -1) {
        const revealed = reveal(state, "", text, event.now, event.animate)
        return append(revealed.state, {
          kind: "assistant",
          text,
          streaming: true,
          reveals: revealed.reveals,
        })
      }
      const previous = state.messages[index]
      if (previous.kind !== "assistant" || previous.text === text) return state
      const appended = text.startsWith(previous.text)
      const revealed = reveal(
        state,
        appended ? previous.text : "",
        appended ? text.slice(previous.text.length) : text,
        event.now,
        event.animate,
      )
      return {
        ...revealed.state,
        messages: state.messages.map((message, currentIndex) =>
          currentIndex === index && message.kind === "assistant"
            ? {
                ...message,
                text,
                reveals: appended
                  ? [...message.reveals, ...revealed.reveals].slice(-REVEAL_WORD_LIMIT)
                  : revealed.reveals,
              }
            : message,
        ),
      }
    }
    case "assistant.done": {
      const index = state.messages.findLastIndex((message) => message.kind === "assistant" && message.streaming)
      if (index === -1) return state
      return {
        ...state,
        messages: state.messages.map((message, currentIndex) =>
          currentIndex === index && message.kind === "assistant" ? { ...message, streaming: false } : message,
        ),
      }
    }
    case "tool.started":
      return append(state, {
        kind: "tool",
        callID: event.callID,
        name: event.name,
        input: event.input,
      })
    case "tool.done":
      return {
        ...state,
        messages: state.messages.map((message) =>
          message.kind === "tool" && message.callID === event.callID ? { ...message, output: event.output } : message,
        ),
      }
    case "reveals.completed":
      return {
        ...state,
        revealAnimationEndsAt: 0,
        messages: state.messages.map((message) =>
          "reveals" in message && message.reveals.length > 0 ? { ...message, reveals: [] } : message,
        ),
      }
  }
  return state
}

function append(state: VoiceViewState, message: NewMessage): VoiceViewState {
  const messageSequence = state.messageSequence + 1
  const next = { ...message, key: `message-${messageSequence}` }
  return { ...state, messageSequence, messages: [...state.messages, next].slice(-MESSAGE_LIMIT) }
}

function reveal(state: VoiceViewState, previous: string, delta: string, now: number, animate: boolean) {
  if (!animate) return { state, reveals: new Array<TextReveal>() }
  const scheduled = scheduleTextReveal(previous, delta, now, state.revealAt)
  return {
    state: {
      ...state,
      revealAt: scheduled.nextRevealAt,
      revealAnimationEndsAt: Math.max(state.revealAnimationEndsAt, scheduled.animationEndsAt),
    },
    reveals: scheduled.reveals,
  }
}

function mergeAssistantRows(messages: ReadonlyArray<Message>) {
  return messages.reduce<Message[]>((result, message) => {
    const previous = result.at(-1)
    if (previous?.kind !== "assistant" || message.kind !== "assistant") return [...result, message]
    return [
      ...result.slice(0, -1),
      {
        key: previous.key,
        kind: "assistant",
        text: joinAssistantText(previous.text, message.text).text,
        streaming: previous.streaming || message.streaming,
        reveals: [],
      },
    ]
  }, [])
}

export function joinAssistantText(left: string, right: string) {
  if (left.trim() === "") return { text: right, previous: "", appended: right }
  if (right.trim() === "") return { text: left, previous: left, appended: "" }
  const head = left.trimEnd()
  const tail = right.trimStart()
  if ((left.slice(head.length) + right.slice(0, right.length - tail.length)).includes("\n"))
    return { text: left + right, previous: left, appended: right }
  const separator = /^[.,;:!?…%)\]}]/.test(tail) || /[([{]$/.test(head) ? "" : " "
  return { text: head + separator + tail, previous: head + separator, appended: tail }
}
