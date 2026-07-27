/** @jsxImportSource @opentui/solid */
// Terminal UI for the voice spike. The TUI keeps conversation order stable
// even though realtime events arrive out of order: a user row is inserted the
// moment the audio buffer commits (before the assistant starts replying) and
// its transcript is filled in when Whisper finishes.
import { createCliRenderer } from "@opentui/core"
import { render, useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { createSignal, For } from "solid-js"

export type VoiceStatus = {
  server?: string
  session?: string
  audio?: string
  voice?: string
  model?: string
}

export type VoiceUI = {
  meta(text: string): void
  userCommitted(itemID: string): void
  userTranscript(itemID: string, text: string): void
  assistantDelta(text: string): void
  assistantDone(): void
  toolStart(callID: string, name: string, input: unknown): void
  toolDone(callID: string, output: unknown): void
  setStatus(patch: VoiceStatus): void
  close(): void
}

type Message =
  | { kind: "user"; itemID: string; text?: string }
  | { kind: "assistant"; text: string; streaming: boolean }
  | { kind: "tool"; callID: string; name: string; input: unknown; output?: unknown }
  | { kind: "meta"; text: string }

const truncate = (text: string, max: number) => (text.length > max ? text.slice(0, max) + "…" : text)

const displayJson = (value: unknown) =>
  JSON.stringify(value, (_, item) => (typeof item === "string" ? truncate(item, 500) : item), 2) ?? "null"

function toolSummary(name: string, output?: unknown) {
  if (output === undefined) return "running"
  if (Array.isArray(output)) return `${output.length} result${output.length === 1 ? "" : "s"}`
  if (!output || typeof output !== "object") return String(output)
  const value = output as Record<string, unknown>
  if (name === "wait_for_reply")
    return `${String(value["status"] ?? "done")} · ${typeof value["text"] === "string" ? `${value["text"].length} chars` : "no reply"}`
  if (name === "prompt_session")
    return `${value["admitted"] ? "admitted" : "rejected"} · ${String(value["sessionID"] ?? "unknown session")}`
  if (name === "check_session") {
    const tools = Array.isArray(value["runningTools"]) ? ` · ${value["runningTools"].join(", ")}` : ""
    return `${String(value["status"] ?? "checked")}${tools}`
  }
  if (name === "create_session" || name === "select_session")
    return `${name === "create_session" ? "created" : "selected"} · ${String(value["sessionID"] ?? "unknown session")}`
  if (name === "interrupt_session") return value["interrupted"] ? "interrupted" : "not interrupted"
  if (name === "set_voice") return `switching to ${String(value["voice"] ?? "unknown")}`
  const fields = Object.entries(value)
    .filter(([, item]) => ["string", "number", "boolean"].includes(typeof item))
    .slice(0, 2)
    .map(([key, item]) => `${key}: ${String(item)}`)
  return fields.join(" · ") || "completed"
}

// ---------------------------------------------------------------------------
// Console fallback (--text mode, non-TTY)
// ---------------------------------------------------------------------------

export function createConsoleUI(): VoiceUI {
  const tty = process.stdout.isTTY
  const dim = (text: string) => (tty ? `\x1b[2m${text}\x1b[0m` : text)
  const cyan = (text: string) => (tty ? `\x1b[1;36m${text}\x1b[0m` : text)
  const green = (text: string) => (tty ? `\x1b[1;32m${text}\x1b[0m` : text)

  let streaming = false
  const tools = new Map<string, string>()
  const line = (text: string) => {
    if (streaming) {
      process.stdout.write("\n")
      streaming = false
    }
    console.log(text)
  }

  return {
    meta: (text) => line(dim(`  ${text}`)),
    userCommitted: () => {},
    userTranscript: (_, text) => line(cyan("● you ") + text),
    assistantDelta: (text) => {
      if (!streaming) {
        process.stdout.write(green("● assistant "))
        streaming = true
      }
      process.stdout.write(text)
    },
    assistantDone: () => {
      if (streaming) process.stdout.write("\n")
      streaming = false
    },
    toolStart: (callID, name) => {
      tools.set(callID, name)
      line(dim(`  ◌ ${name}  running`))
    },
    toolDone: (callID, output) => {
      const name = tools.get(callID) ?? "tool"
      tools.delete(callID)
      line(dim(`  ✓ ${name}  ${toolSummary(name, output)}`))
    },
    setStatus: () => {},
    close: () => {},
  }
}

// ---------------------------------------------------------------------------
// OpenTUI
// ---------------------------------------------------------------------------

const theme = {
  text: "#c0caf5",
  muted: "#565f89",
  you: "#7dcfff",
  assistant: "#9ece6a",
  key: "#7aa2f7",
  string: "#9ece6a",
  number: "#e0af68",
  literal: "#bb9af7",
}

// Tiny JSON tokenizer for syntax-highlighted tool results.
function jsonTokens(json: string) {
  const tokens: Array<{ text: string; color: string }> = []
  const pattern = /("(?:[^"\\]|\\.)*")(\s*:)?|(-?\d+\.?\d*(?:[eE][+-]?\d+)?)|(true|false|null)|([{}\[\],:]+|\s+)/g
  for (const match of json.matchAll(pattern)) {
    if (match[1] !== undefined) {
      tokens.push({ text: match[1], color: match[2] ? theme.key : theme.string })
      if (match[2]) tokens.push({ text: match[2], color: theme.muted })
      continue
    }
    if (match[3] !== undefined) {
      tokens.push({ text: match[3], color: theme.number })
      continue
    }
    if (match[4] !== undefined) {
      tokens.push({ text: match[4], color: theme.literal })
      continue
    }
    tokens.push({ text: match[5] ?? "", color: theme.muted })
  }
  return tokens
}

// `kind` never changes after creation, so branching once here is safe; the
// property reads inside JSX stay reactive through the store proxy.
function MessageRow(props: { message: Message; details: boolean }) {
  const message = props.message
  if (message.kind === "user")
    return (
      <text fg={theme.you} marginTop={1}>
        <b>● you</b> <span style={{ fg: theme.text }}>{message.text ?? "…"}</span>
      </text>
    )
  if (message.kind === "assistant")
    return (
      <text fg={theme.assistant} marginTop={1}>
        <b>● assistant</b> <span style={{ fg: theme.text }}>{message.text}</span>
        <span style={{ fg: theme.muted }}>{message.streaming ? " …" : ""}</span>
      </text>
    )
  if (message.kind === "tool")
    return (
      <box flexDirection="column" paddingLeft={2}>
        <text fg={theme.muted}>
          <span style={{ fg: message.output === undefined ? theme.number : theme.assistant }}>
            {message.output === undefined ? "◌" : "✓"}
          </span>{" "}
          <span style={{ fg: theme.key }}>{message.name}</span>{"  "}
          {toolSummary(message.name, message.output)}
        </text>
        {props.details ? (
          <text fg={theme.muted} paddingLeft={2}>
            <For each={jsonTokens(displayJson({ input: message.input, output: message.output }))}>
              {(token) => <span style={{ fg: token.color }}>{token.text}</span>}
            </For>
          </text>
        ) : null}
      </box>
    )
  return (
    <text fg={theme.muted} paddingLeft={2}>
      · {message.text}
    </text>
  )
}

export async function createVoiceTUI(options: {
  onInterrupt(): void
  onExit(): void
  onCycleVoice(): void
}): Promise<VoiceUI> {
  const [state, setState] = createSignal({
    messages: [] as Message[],
    status: {} as VoiceStatus,
    details: false,
  })

  const renderer = await createCliRenderer({
    useMouse: true,
    // Handle Ctrl-C in OpenTUI's native input parser, before Solid handlers
    // and rendering work. onDestroy performs process/audio cleanup below.
    exitOnCtrlC: true,
    exitSignals: [],
    autoFocus: false,
    openConsoleOnError: false,
    screenMode: "alternate-screen",
    externalOutputMode: "passthrough",
    consoleMode: "disabled",
    onDestroy: options.onExit,
  })

  function App() {
    const dimensions = useTerminalDimensions()
    useKeyboard((evt) => {
      if (evt.ctrl && evt.name === "c") return
      if (evt.name === "v") return options.onCycleVoice()
      if (evt.name === "d") {
        setState((current) => ({ ...current, details: !current.details }))
        renderer.requestRender()
        return
      }
      options.onInterrupt()
    })
    const statusLine = () =>
      [
        state().status.audio ?? "connecting…",
        state().status.voice,
        state().status.model,
        state().status.session ?? "no session",
        state().status.server,
        `v: voice · d: details ${state().details ? "on" : "off"} · any key interrupts · ctrl+c quits`,
      ]
        .filter(Boolean)
        .join("   ")
    return (
      <box
        flexDirection="column"
        width={dimensions().width}
        height={dimensions().height}
        paddingLeft={1}
        paddingRight={1}
      >
        <scrollbox flexGrow={1} stickyScroll stickyStart="bottom" scrollbarOptions={{ visible: false }}>
          <box flexDirection="column" flexShrink={0}>
            <For each={state().messages}>
              {(message) => <MessageRow message={message} details={state().details} />}
            </For>
          </box>
        </scrollbox>
        <box height={1} marginTop={1}>
          <text fg={theme.muted}>{statusLine()}</text>
        </box>
      </box>
    )
  }

  void render(() => <App />, renderer)

  const redraw = () => renderer.requestRender()
  const push = (message: Message) => {
    setState((current) => ({ ...current, messages: [...current.messages, message] }))
    redraw()
  }

  return {
    meta: (text) => push({ kind: "meta", text }),
    userCommitted: (itemID) => push({ kind: "user", itemID }),
    userTranscript: (itemID, text) => {
      const index = state().messages.findIndex((m) => m.kind === "user" && m.itemID === itemID)
      if (index === -1) return push({ kind: "user", itemID, text })
      setState((current) => ({
        ...current,
        messages: current.messages.map((message, i) =>
          i === index && message.kind === "user" ? { ...message, text } : message,
        ),
      }))
      redraw()
    },
    assistantDelta: (text) => {
      const index = state().messages.length - 1
      const last = state().messages[index]
      if (last?.kind === "assistant" && last.streaming) {
        setState((current) => ({
          ...current,
          messages: current.messages.map((message, i) =>
            i === index && message.kind === "assistant" ? { ...message, text: message.text + text } : message,
          ),
        }))
        redraw()
        return
      }
      push({ kind: "assistant", text, streaming: true })
    },
    assistantDone: () => {
      const index = state().messages.length - 1
      if (state().messages[index]?.kind !== "assistant") return
      setState((current) => ({
        ...current,
        messages: current.messages.map((message, i) =>
          i === index && message.kind === "assistant" ? { ...message, streaming: false } : message,
        ),
      }))
      redraw()
    },
    toolStart: (callID, name, input) => push({ kind: "tool", callID, name, input }),
    toolDone: (callID, output) => {
      const index = state().messages.findIndex((message) => message.kind === "tool" && message.callID === callID)
      if (index === -1) return
      setState((current) => ({
        ...current,
        messages: current.messages.map((message, i) =>
          i === index && message.kind === "tool" ? { ...message, output } : message,
        ),
      }))
      redraw()
    },
    setStatus: (patch) => {
      setState((current) => ({ ...current, status: { ...current.status, ...patch } }))
      redraw()
    },
    close: () => {
      if (!renderer.isDestroyed) renderer.destroy()
    },
  }
}
